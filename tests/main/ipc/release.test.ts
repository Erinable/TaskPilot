// IPC channels of the release domain (src/main/ipc/release.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

// ========== Release Manager ==========

const gitIn = async (root: string, args: string[]) => (await fixtures.run('git', args, { cwd: root })).stdout.trim();

// Tags the harness's first commit and adds one more, so tag..HEAD has a change.
const releaseRepo = async (root: string) => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.3.1' }));
  await gitIn(root, ['add', '.']);
  await gitIn(root, ['commit', '-qm', 'chore: add manifest']);
  await gitIn(root, ['tag', 'v0.3.1']);
  await fs.writeFile(path.join(root, 'src/auth/application/login-user.ts'), 'export const login = () => true;\n');
  await gitIn(root, ['commit', '-qam', 'feat: email login']);
  return gitIn(root, ['rev-parse', 'HEAD']);
};

const settleRelease = async (call) =>
  fixtures.until(
    async () => (await call(CHANNELS.releaseGet)).data,
    (data) => Boolean(data.draft && data.draft.status !== 'generating' && !data.running),
    'release draft',
  );

const readyRelease = async (h) => {
  const head = await releaseRepo(h.root);
  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'ready', JSON.stringify(state.draft.error));
  return { head, state };
};

test('release: generate from the newest tag yields a ready draft with computed version', async () => {
  const done = { status: 'done', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };
  const h = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { 'auth-email-login': done } });
  const before = (await h.call(CHANNELS.releaseGet)).data;
  assert.equal(before.configured, true);
  assert.deepEqual(before.startPoint, { kind: 'none', commit: null, label: null, commitCount: 0, commitsTruncated: false, packageCount: 0 });

  await releaseRepo(h.root);
  const preview = (await h.call(CHANNELS.releaseGet)).data.startPoint;
  assert.deepEqual([preview.kind, preview.commitCount, preview.commitsTruncated, preview.packageCount], ['tag', 1, false, 1]);
  assert.equal(h.agentCalls.length, 0, 'the preview never calls the model');

  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.ok, true);
  const state = await settleRelease(h.call);
  const head = await gitIn(h.root, ['rev-parse', 'HEAD']);
  assert.equal(state.startPoint.kind, 'tag');
  assert.equal(state.startPoint.label, 'v0.3.1');
  assert.equal(state.draft.endCommit, head);
  assert.equal(state.draft.plan.currentVersion, '0.3.1');
  assert.equal(state.draft.plan.nextVersion, '0.4.0');
  assert.deepEqual(state.draft.plan.checklist[0].evidence, ['src/auth/application/login-user.ts']);
  assert.match(state.draft.notesText, /支持邮箱登录/);
  assert.deepEqual(state.draft.input.packageIds, ['auth-email-login']);

  const prompt = fixtures.callFor(h.agentCalls, 'release').prompt;
  assert.match(prompt, /feat: email login/);
  assert.doesNotMatch(prompt, /chore: add manifest/, 'commits before the tag are not in range');
  assert.doesNotMatch(prompt, /export const login/, 'file contents never reach the prompt');
  assert.match(prompt, /<package id="auth-email-login">/);
});

test('release: a start commit from the renderer must be the start point or a recent commit', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const first = await gitIn(h.root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(h.root, 'README.md'), '# demo\n');
  await gitIn(h.root, ['add', '.']);
  await gitIn(h.root, ['commit', '-qm', 'docs: readme']);

  // No release and no tag: the user must pick.
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_no_start');
  for (const bad of ['HEAD', first.slice(0, 7), '--output=/tmp/x', 'f'.repeat(40), 42]) {
    const response = await h.call(CHANNELS.releaseGenerate, bad);
    assert.equal(response.ok, false, String(bad));
    assert.equal(response.error.code, typeof bad === 'string' ? 'release_bad_start' : 'invalid_argument', String(bad));
    assert.equal(response.error.field ?? 'startCommit', 'startCommit');
  }
  const commits = (await h.call(CHANNELS.releaseRecentCommits)).data;
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['docs: readme', 'init'],
  );
  assert.ok(commits.every((commit) => /^[0-9a-f]{40}$/.test(commit.sha) && commit.date));

  // HEAD itself is a recent commit, but the range would be empty.
  assert.equal((await h.call(CHANNELS.releaseGenerate, commits[0].sha)).error.code, 'release_no_changes');
  assert.equal((await h.call(CHANNELS.releaseGenerate, first)).ok, true);
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'ready');
  assert.equal(state.draft.startCommit, first);
  assert.equal(h.agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'release').length, 1);
});

test('release: finish refuses unchecked items, then records the release and its activity', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const { head } = await readyRelease(h);
  assert.equal((await h.call(CHANNELS.releaseFinish)).error.code, 'release_unchecked');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { checked: [0] })).ok, true);
  assert.equal((await h.call(CHANNELS.releaseFinish)).error.code, 'release_unchecked');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { checked: [5] })).error.code, 'invalid_argument');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { notes: 'x'.repeat(20001) })).error.code, 'too_long');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, null)).error.code, 'invalid_argument');

  const edited = await h.call(CHANNELS.releaseUpdateDraft, { notes: '### 新增\n\n- 手改的说明', checked: [0, 1] });
  assert.deepEqual(edited.data.draft.checked, [0, 1]);
  const finished = await h.call(CHANNELS.releaseFinish);
  assert.equal(finished.ok, true);
  assert.equal(finished.data.version, '0.4.0');
  assert.equal(finished.data.endCommit, head);
  assert.equal(finished.data.notesText, '### 新增\n\n- 手改的说明');

  const state = (await h.call(CHANNELS.releaseGet)).data;
  assert.equal(state.draft, null);
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.startPoint, { kind: 'release', commit: head, label: '0.4.0', commitCount: 0, commitsTruncated: false, packageCount: 0 });
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_no_changes');

  const [event] = (await fixtures.overviewWith(h.call, 1)).recent;
  assert.deepEqual(
    { kind: event.kind, version: event.version, packageCount: event.packageCount },
    { kind: 'release_finished', version: '0.4.0', packageCount: 0 },
  );
});

test('release: write-notes validates the path and prepends under a dated heading', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, { path: 'CHANGELOG.md' })).error.code, 'invalid_state');
  await readyRelease(h);
  await fs.mkdir(path.join(h.root, 'outside-link-target'), { recursive: true });
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-elsewhere-'));
  onTestFinished(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await fs.symlink(elsewhere, path.join(h.root, 'linked'));

  const refused = {
    '../CHANGELOG.md': 'path_outside_workspace',
    [path.join(h.root, 'CHANGELOG.md')]: 'path_not_relative',
    '.git/CHANGELOG.md': 'path_in_git',
    'CHANGELOG.txt': 'path_not_markdown',
    'secrets.md': 'path_secret',
    'missing-dir/CHANGELOG.md': 'invalid_argument',
    'linked/CHANGELOG.md': 'path_outside_workspace',
    'outside-link-target': 'path_not_markdown',
  };
  for (const [candidate, code] of Object.entries(refused)) {
    const response = await h.call(CHANNELS.releaseWriteNotes, { path: candidate });
    assert.equal(response.ok, false, candidate);
    assert.equal(response.error.code, code, candidate);
    assert.equal(response.error.field, 'path', candidate);
  }
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, {})).error.code, 'invalid_argument');
  assert.deepEqual(await fs.readdir(elsewhere), []);

  await fs.writeFile(path.join(h.root, 'CHANGELOG.md'), '## 0.3.1 — 2026-01-01\n\n- 旧版本\n');
  const written = await h.call(CHANNELS.releaseWriteNotes, { path: './CHANGELOG.md' });
  assert.deepEqual(written.data, { path: 'CHANGELOG.md' });
  const text = await fs.readFile(path.join(h.root, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /^## 0\.4\.0 — \d{4}-\d{2}-\d{2}\n\n### 新增\n\n- 支持邮箱登录\n\n## 0\.3\.1 — 2026-01-01/);

  // A new file in an existing directory is created; nothing is staged.
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, { path: 'src/RELEASE.md' })).ok, true);
  assert.match(await fs.readFile(path.join(h.root, 'src/RELEASE.md'), 'utf8'), /^## 0\.4\.0 — /);
  assert.equal(await gitIn(h.root, ['diff', '--cached', '--name-only']), '');
});

test('release: a running generation shows Release Manager busy and can be cancelled', async () => {
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const h = await fixtures.harness({
    agent: async (options) => {
      await blocked;
      return fixtures.fakeAgent()(options);
    },
  });
  await releaseRepo(h.root);
  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.data.running, true);
  assert.equal(started.data.draft.status, 'generating');
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_busy');
  assert.ok((await h.call(CHANNELS.activityOverview)).data.team.busy.includes('release-manager'));
  assert.equal((await h.call(CHANNELS.releaseCancel)).data, true);
  unblock();
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'failed');
  assert.equal(state.draft.error.code, 'agent_cancelled');
  assert.equal((await h.call(CHANNELS.releaseCancel)).data, false);
});

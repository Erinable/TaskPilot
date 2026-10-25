// IPC channels of the repositories domain (src/main/ipc/repositories.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_REQUIREMENT, SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as git from '../../../src/main/git.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('repositories:add rejects a root that is not a git repository', async () => {
  const { call } = await fixtures.harness({ withRepo: false });
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-plain-'));
  onTestFinished(() => fs.rm(plain, { recursive: true, force: true }));
  const response = await call(CHANNELS.repositoriesAdd, plain, true);
  assert.equal(response.error.code, 'not_a_repo');
  assert.equal(response.error.field, 'root');
});

test('repositories:add registers nothing for a rejected root', async () => {
  const { call } = await fixtures.harness({ withRepo: false });
  assert.equal((await call(CHANNELS.repositoriesAdd, '/definitely/not/here', true)).error.code, 'root_not_found');
  assert.equal((await call(CHANNELS.repositoriesAdd, 'projects/app', true)).error.code, 'root_not_absolute');
  assert.deepEqual((await call(CHANNELS.repositoriesList)).data, { current: null, repositories: [] });
});

test('repositories: adding without opening keeps the open repository, and the list counts work in each', async () => {
  const h = await fixtures.harness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const other = await fixtures.gitRepo();
  const added = await h.call(CHANNELS.repositoriesAdd, other, false);
  assert.equal(added.ok, true);
  const open = added.data.repositories.find((entry) => entry.current);
  assert.equal(await fs.realpath(open.root), await fs.realpath(h.root));
  assert.equal((await h.call(CHANNELS.getTask, 'auth-edge-tests')).data.status, 'in_progress', 'nothing was reloaded');
  // The open repository counts from memory: the sample packages, one claimed.
  assert.equal(open.counts.active, 1);
  assert.equal(open.counts.pending, SAMPLE_TASKS.filter((task) => task.status === 'pending').length - 1);
  // The new one has no saved data yet.
  assert.deepEqual(added.data.repositories.find((entry) => !entry.current).counts, { pending: 0, active: 0, accepting: 0 });
});

test('repositories:add normalizes a subdirectory to the repository root', async () => {
  // git reports diff paths from the top level, so a subdirectory root would
  // make every file scope miss.
  const { call } = await fixtures.harness({ withRepo: false });
  const root = await fixtures.gitRepo();
  const response = await call(CHANNELS.repositoriesAdd, path.join(root, 'src'), true);
  assert.equal(response.ok, true);
  assert.equal(response.data.repositories.length, 1);
  assert.equal(await fs.realpath(response.data.repositories[0].root), await fs.realpath(root));
});

test('repositories: each repository keeps its own requirements, progress and commands', async () => {
  const { call, root } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  await call(CHANNELS.workspaceSet, { root, commands: { test: 'npm test' } });
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const { data: created } = await call(CHANNELS.requirementsCreate, { text: 'first repo' });
  await fixtures.settle(call, created.id);

  const other = await fixtures.gitRepo();
  const added = (await call(CHANNELS.repositoriesAdd, other, true)).data;
  assert.equal(added.repositories.length, 2);
  assert.equal(added.repositories.find((repo) => repo.current).root, await git.topLevel(other));
  assert.deepEqual((await call(CHANNELS.requirementsList)).data, []);
  assert.deepEqual((await call(CHANNELS.listTasks)).data, []);
  assert.equal((await call(CHANNELS.workspaceGet)).data.lines.test, '');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.root, await git.topLevel(other));

  const first = added.repositories.find((repo) => !repo.current);
  await call(CHANNELS.repositoriesSwitch, first.id);
  assert.deepEqual(
    (await call(CHANNELS.requirementsList)).data.map((item) => item.text),
    ['first repo', SAMPLE_REQUIREMENT.text],
  );
  assert.equal((await call(CHANNELS.workspaceGet)).data.lines.test, 'npm test');
});

test('repositories: switching cancels running work and waits for its writes', async () => {
  const agent: fixtures.FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await fixtures.harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { title: '登录', text: 't' });
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'requirement', label: '登录' }]);

  const first = (await call(CHANNELS.repositoriesList)).data.current;
  await call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, []);
  await call(CHANNELS.repositoriesSwitch, first);
  const item = (await call(CHANNELS.requirementsGet, data.id)).data;
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'agent_cancelled');
});

test('repositories: a moved repository is flagged and can be pointed at its new place', async () => {
  const { call, root } = await fixtures.harness();
  const { current } = (await call(CHANNELS.repositoriesList)).data;
  const moved = `${root}-moved`;
  await fs.rename(root, moved);
  onTestFinished(() => fs.rm(moved, { recursive: true, force: true }));
  assert.equal((await call(CHANNELS.repositoriesList)).data.repositories[0].missing, true);

  const relocated = (await call(CHANNELS.repositoriesRelocate, current, moved)).data;
  assert.equal(relocated.current, current, 'the id and its data stay');
  assert.equal(relocated.repositories[0].missing, false);
  assert.equal((await call(CHANNELS.workspaceInfo)).data.root, await git.topLevel(moved));
});

test('repositories: switching to an unknown id is refused', async () => {
  const { call } = await fixtures.harness();
  assert.equal((await call(CHANNELS.repositoriesSwitch, 'nope')).error.code, 'unknown_repository');
});

test('repositories: switching cancels a running tutor answer so it cannot land in the next repository', async () => {
  // The answer is slow; it finishes only after cancellation or when released.
  const release = Promise.withResolvers<void>();
  let cancelled = false;
  const agent: fixtures.FakeAgent = async (options) => {
    if (fixtures.stepOf(options.schema) !== 'tutor') return fixtures.fakeAgent()(options);
    options.signal!.addEventListener('abort', () => (cancelled = true));
    await release.promise;
    return fixtures.fakeAgent()(options);
  };
  const { call } = await fixtures.harness({ agent, seedState: { 'auth-edge-tests': fixtures.claimedState } });
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0);
  // Adding a repository switches to it; the switch must stop the tutor first.
  const switching = call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  for (let index = 0; index < 200 && !cancelled; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  release.resolve();
  await switching;
  assert.equal(cancelled, true, 'the tutor run was not cancelled');
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, []);
});

test('repositories: a switch drops the coding events and tutor failures of the repository it leaves', async () => {
  const events = [{ sequence: 0, at: new Date().toISOString(), type: 'text' as const, text: 'done' }];
  const agent: fixtures.FakeAgent = async () => ({ output: { explanation: '', hints: [], snippet: null, terms: [] }, costUsd: 0 });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const { call } = await fixtures.harness({
    agent,
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async () => ({
        output: 'done',
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
        events,
        sessionId: null,
      }),
      codingReadPatch: async () => fixtures.filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});'),
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  await call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  assert.equal((await fixtures.settleCoding(call, 'auth-edge-tests')).codingRun?.status, 'ready');
  assert.equal((await call(CHANNELS.codingEvents, 'auth-edge-tests', -1)).data.events.length, 1);
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0);
  assert.equal((await fixtures.settleTutor(call, 'auth-edge-tests', 0)).status, 'failed');

  const first = (await call(CHANNELS.repositoriesList)).data.current;
  await call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  await call(CHANNELS.repositoriesSwitch, first);
  assert.equal((await call(CHANNELS.codingGet, 'auth-edge-tests')).data.codingRun?.status, 'ready');
  assert.deepEqual((await call(CHANNELS.codingEvents, 'auth-edge-tests', -1)).data.events, []);
  assert.equal((await call(CHANNELS.tutorGet, 'auth-edge-tests', 0)).data.status, 'idle');
});

/** @module-tag integration */
// IPC channels of the environment domain (src/main/ipc/environment.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import { until } from '../../fixtures/until.ts';
import { gitRepo } from '../../fixtures/git_repo.ts';
import { ENV_CONFIGURATION } from '../fixtures/environment.ts';
import * as git from '../../../src/main/repository/git.ts';
import { AgentRunError } from '../../../src/main/runtimes/claude_cli.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import { typescriptSetup } from '../../../src/main/checking/presets/typescript_setup.ts';
import { createPathResolver } from '../../../src/main/infrastructure/shell_env.ts';

/** Commits a dependency-free package.json and switches to the login-shell PATH so node/npm resolve. */
const envHarness = async (options: { overrides?: Record<string, unknown> } & Record<string, unknown> = {}) => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent(options.overrides), ...options });
  const manifest = {
    name: 'env-fixture',
    private: true,
    scripts: { test: 'node -e "console.log(\'tests ok\')"', lint: 'node -e "console.error(\'lint broke\'); process.exit(3)"' },
  };
  await fs.writeFile(path.join(h.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fixtures.run('git', ['add', 'package.json'], { cwd: h.root });
  await fixtures.run('git', ['commit', '-qm', 'manifest'], { cwd: h.root });
  await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'login-shell' } }));
  return h;
};

const settleEnv = async (call) =>
  until(
    async () => (await call(CHANNELS.envGet)).data,
    (data) => data.status !== 'planning',
    'environment plan',
  );

test('env: plan, confirm steps one by one, then apply the scripts', async () => {
  const { call, repoDir } = await envHarness();
  const started = await call(CHANNELS.envPlan);
  assert.equal(started.data.status, 'planning');
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  assert.deepEqual(view.blockers, []);
  assert.deepEqual(view.stepKinds, ['test', 'lint', 'build', 'typecheck', 'format', 'coverage']);
  assert.deepEqual(
    view.steps.map((s) => [s.id, s.line]),
    [
      ['install', 'npm install --ignore-scripts --no-audit --no-fund'],
      ['test', 'npm test'],
      ['lint', 'npm run lint'],
    ],
  );

  const installed = await call(CHANNELS.envRunStep, 'install');
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  assert.equal(installed.data.steps[0].result.ok, true, installed.data.steps[0].result.output);

  const tested = (await call(CHANNELS.envRunStep, 'test')).data.steps[1].result;
  assert.equal(tested.ok, true);
  assert.match(tested.output, /tests ok/);

  const linted = (await call(CHANNELS.envRunStep, 'lint')).data.steps[2].result;
  assert.equal(linted.ok, false);
  assert.equal(linted.exitCode, 3);

  const applied = await call(CHANNELS.envApply, ['test']);
  assert.equal(applied.data.configured.test, 'npm test');
  assert.equal(applied.data.configured.lint, '');
  const saved = JSON.parse(await fs.readFile(path.join(repoDir, 'workspace.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.steps.test, {
    enabled: true,
    commands: [{ command: 'npm', args: ['test'] }],
    cwd: '',
    stage: 'submit',
    blocking: true,
    parser: { format: 'tests' },
    env: {},
  });
});

test('env: a running step shows its output and start time, and a step reading stdin still finishes', async () => {
  const h = await envHarness();
  const manifest = {
    name: 'env-fixture',
    private: true,
    // Prints, then waits for stdin to end before finishing.
    scripts: {
      test: "node -e \"console.log('halfway'); process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => console.log('done'), 300))\"",
      lint: 'node -e 0',
    },
  };
  await fs.writeFile(path.join(h.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fixtures.run('git', ['commit', '-qam', 'stdin script'], { cwd: h.root });
  await h.call(CHANNELS.envPlan);
  await settleEnv(h.call);
  const finished = h.call(CHANNELS.envRunStep, 'test');
  const live = await until(
    async () => (await h.call(CHANNELS.envGet)).data.live,
    (value) => Boolean(value?.output.includes('halfway')),
    'environment step output',
  );
  assert.match(live?.output ?? '', /halfway/);
  assert.ok(Number.isFinite(Date.parse(live!.startedAt)));
  const view = (await finished).data;
  assert.equal(view.live, null);
  const result = view.steps.find((step) => step.id === 'test').result;
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /done/);
});

test('env: lifecycle-script permission rebuilds the install command executed through IPC', async () => {
  const h = await envHarness();
  const marker = path.join(h.root, 'install-marker');
  const manifest = JSON.parse(await fs.readFile(path.join(h.root, 'package.json'), 'utf8'));
  manifest.scripts.postinstall = `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`;
  await fs.writeFile(path.join(h.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fixtures.run('git', ['commit', '-qam', 'postinstall'], { cwd: h.root });
  await h.call(CHANNELS.envPlan);
  await settleEnv(h.call);

  const blocked = (await h.call(CHANNELS.envSetAllowScripts, false)).data;
  assert.match(blocked.steps[0].line, /--ignore-scripts/);
  const blockedRun = (await h.call(CHANNELS.envRunStep, 'install')).data;
  assert.equal(blockedRun.steps[0].result.line, blocked.steps[0].line);
  await assert.rejects(() => fs.access(marker));

  const allowed = (await h.call(CHANNELS.envSetAllowScripts, true)).data;
  assert.doesNotMatch(allowed.steps[0].line, /--ignore-scripts/);
  const allowedRun = (await h.call(CHANNELS.envRunStep, 'install')).data;
  assert.equal(allowedRun.steps[0].result.line, allowed.steps[0].line);
  await fs.access(marker);

  await fs.rm(marker);
  await h.call(CHANNELS.envSetAllowScripts, false);
  await h.call(CHANNELS.envRunStep, 'install');
  await assert.rejects(() => fs.access(marker));
});

test('env: steps are refused without a plan, by unknown id, or after the root changes', async () => {
  const { call, setRoot } = await envHarness();
  assert.equal((await call(CHANNELS.envRunStep, 'install')).error.code, 'env_no_plan');
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  assert.equal((await call(CHANNELS.envRunStep, 'rm -rf /')).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['build'])).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['deploy'])).error.code, 'invalid_argument');
  // A step kind without an existing script still cannot be applied.
  assert.equal((await call(CHANNELS.envApply, ['typecheck'])).error.code, 'invalid_argument');
  setRoot(os.tmpdir());
  assert.equal((await call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await call(CHANNELS.envRunStep, 'test')).error.code, 'env_stale');
});

test('env: a repository with only a README has no skeleton to set up, and nothing calls the steward', async () => {
  let calls = 0;
  const h = await fixtures.harness({
    withRepo: false,
    agent: async () => {
      calls += 1;
      throw new Error('not called');
    },
  });
  const { root } = await gitRepo({ 'README.md': '# app\n', '.gitignore': 'node_modules\n' });
  await h.call(CHANNELS.repositoriesAdd, root, true);
  assert.equal((await h.call(CHANNELS.workspaceGet)).data.blank, true);
  await h.call(CHANNELS.envPlan);
  const view = await settleEnv(h.call);
  assert.deepEqual(view.blockers, ['no_skeleton']);
  assert.equal(calls, 0);
});

const configurationHarness = () => envHarness({ overrides: { env: { ...fixtures.ENV_PLAN, configuration: ENV_CONFIGURATION } } });

test('env: a reviewed proposal publishes one ordinary pending configuration package without changing repository files', async () => {
  const h = await configurationHarness();
  assert.equal((await h.call(CHANNELS.envCreateConfiguration)).error.code, 'env_no_plan');
  await h.call(CHANNELS.envPlan);
  const plan = await settleEnv(h.call);
  assert.deepEqual(plan.plan.configuration, ENV_CONFIGURATION);
  const before = await git.status(h.root);
  const calls = h.agentCalls.length;
  const [first, repeated] = await Promise.all([h.call(CHANNELS.envCreateConfiguration), h.call(CHANNELS.envCreateConfiguration)]);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(repeated.data.id, first.data.id);
  const task = (await h.call(CHANNELS.tasksGet, first.data.id)).data;
  assert.equal(task.status, 'pending');
  assert.equal(task.recommendedMode.mode, 'ai');
  assert.deepEqual(task.fileScope, ENV_CONFIGURATION.fileScope);
  assert.deepEqual(task.steps, ENV_CONFIGURATION.steps);
  assert.equal((await h.call(CHANNELS.envGet)).data.configurationPackage.id, task.id);
  assert.deepEqual(await git.status(h.root), before);
  assert.equal(h.agentCalls.length, calls, 'publishing does not call a model');
  assert.equal(h.requirements.listTasks().filter((entry) => entry.environment).length, 1);
  await h.call(CHANNELS.envPlan);
  await settleEnv(h.call);
  assert.equal((await h.call(CHANNELS.envCreateConfiguration)).data.id, task.id, 're-analysis reuses unfinished work');
});

test('env: committing or staging changes makes a configuration proposal stale', async () => {
  const h = await configurationHarness();
  await h.call(CHANNELS.envPlan);
  await settleEnv(h.call);
  const file = path.join(h.root, 'package.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.scripts.typecheck = 'node -e 0';
  await fs.writeFile(file, JSON.stringify(manifest));
  await fixtures.run('git', ['add', 'package.json'], { cwd: h.root });
  assert.equal((await h.call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await h.call(CHANNELS.envCreateConfiguration)).error.code, 'env_stale');
  assert.equal((await h.call(CHANNELS.envApply, ['test'])).error.code, 'env_stale');
  assert.equal((await h.call(CHANNELS.envRunStep, 'test')).error.code, 'env_stale');
  await fixtures.run('git', ['commit', '-qm', 'add typecheck'], { cwd: h.root });
  assert.equal((await h.call(CHANNELS.envGet)).data.stale, true);
  assert.equal(h.requirements.listTasks().filter((entry) => entry.environment).length, 0);
});

test('env: configuration packages survive reopening, and new scripts are recognized after a fresh analysis', async () => {
  const output = { ...fixtures.ENV_PLAN, scripts: { ...fixtures.ENV_PLAN.scripts }, configuration: ENV_CONFIGURATION };
  const h = await envHarness({ overrides: { env: output } });
  await h.call(CHANNELS.envPlan);
  await settleEnv(h.call);
  const created = (await h.call(CHANNELS.envCreateConfiguration)).data;
  // Simulate the existing Coding Agent / acceptance flow producing repository config.
  await h.store.transition(created.id, 'claim', 'human', { baseline: await git.head(h.root), mode: 'ai' });
  await h.store.transition(created.id, 'submit_for_review', 'human');
  await h.store.transition(created.id, 'review_accepted', 'agent');
  const manifest = JSON.parse(await fs.readFile(path.join(h.root, 'package.json'), 'utf8'));
  manifest.scripts.typecheck = 'node -e 0';
  manifest.scripts['format:check'] = 'node -e 0';
  await fs.writeFile(path.join(h.root, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(h.root, 'taskpilot.toml'), 'preset = "typescript"\n');
  assert.equal((await h.call(CHANNELS.envGet)).data.configurationPackage.needsCommit, true);
  await fixtures.run('git', ['add', 'package.json', 'taskpilot.toml'], { cwd: h.root });
  await fixtures.run('git', ['commit', '-qm', 'configure checks'], { cwd: h.root });
  const workspace = (await h.call(CHANNELS.workspaceGet)).data;
  for (const kind of ['typecheck', 'format']) assert.ok(workspace.steps.find((step) => step.id === kind)?.effective);
  assert.equal((await h.call(CHANNELS.envGet)).data.configurationPackage.needsCommit, false);
  // Reopen the same repository through the real registry, which resets the session.
  const other = await gitRepo({ 'README.md': '# another\n' });
  await h.call(CHANNELS.repositoriesAdd, other.root, true);
  await h.call(CHANNELS.repositoriesAdd, h.root, true);
  const reopened = (await h.call(CHANNELS.envGet)).data;
  assert.equal(reopened.status, 'idle');
  assert.equal(reopened.configurationPackage.id, created.id);
  assert.equal(reopened.configurationPackage.status, 'done');
  Object.assign(output.scripts, { typecheck: 'typecheck', format: 'format:check' });
  await h.call(CHANNELS.envPlan);
  const refreshed = await settleEnv(h.call);
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.plan.scripts.typecheck, 'typecheck');
  assert.equal(refreshed.plan.scripts.format, 'format:check');
  assert.ok(refreshed.steps.some((step) => step.id === 'typecheck'));
});

const appliedConfiguration = async () => {
  const manifest = {
    name: 'env-fixture',
    private: true,
    scripts: {
      test: `node -e "require('fs').writeFileSync('check-marker', 'checked')"`,
      postinstall: `node -e "require('fs').writeFileSync('install-marker', 'ran')"`,
    },
  };
  const preview = fixtures.filePatch('package.json', JSON.stringify(manifest), ENV_CONFIGURATION.fileScope);
  let rounds = 0;
  const h = await envHarness({
    overrides: { env: { ...fixtures.ENV_PLAN, install: { mode: 'skip', reason: '之前已经安装' }, configuration: ENV_CONFIGURATION } },
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options.runName, directory: options.runName }),
      codingSnapshot: async (_root, baseline) => baseline,
      codingRun: async () => {
        rounds += 1;
        return {
          output: '配置已补齐',
          events: [],
          sessionId: null,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0 },
        };
      },
      codingReadPatch: async () => preview,
      codingApplyPatch: async (root) => {
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
        return { written: ['package.json'], markers: [], kept: [] };
      },
      codingClean: async () => {},
    },
  });
  await h.call(CHANNELS.workspaceSet, {
    root: h.root,
    steps: { test: { enabled: true, lines: ['npm test'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null } },
  });
  await h.call(CHANNELS.envPlan);
  const before = await settleEnv(h.call);
  assert.ok(!before.steps.some((step) => step.id === 'install'));
  const { data: work } = await h.call(CHANNELS.envCreateConfiguration);
  assert.equal((await h.call(CHANNELS.packagesTransition, work.id, 'claim', { mode: 'ai' })).ok, true);
  assert.equal((await h.call(CHANNELS.codingStart, work.id, { instruction: '按环境管家方案配置' })).ok, true);
  await fixtures.settleCoding(h.call, work.id);
  const patch = (await h.call(CHANNELS.codingPatch, work.id)).data;
  assert.equal((await h.call(CHANNELS.codingApply, work.id, { digest: patch.mergeDigest, files: ['package.json'], allowHighRisk: true })).ok, true);
  const waiting = await fixtures.settleCoding(h.call, work.id);
  assert.ok(waiting.codingRun);
  assert.equal(waiting.codingRun.status, 'applied');
  assert.equal(waiting.codingRun.halt, 'setup_required');
  assert.equal(waiting.status, 'in_progress', 'QA has not started before the explicit install');
  return { h, work, rounds: () => rounds };
};

const reopenConfiguration = async (source: Awaited<ReturnType<typeof appliedConfiguration>>['h'], options: Parameters<typeof fixtures.harness>[0] = {}) => {
  await source.shutdown();
  // New IPC registration and fresh stores, loaded from the previous app's files.
  const reopened = await fixtures.harness({ withRepo: false, agent: fixtures.fakeAgent(), ...options });
  const added = await reopened.repositories.add(await git.topLevel(source.root));
  await fs.cp(source.repoDir, reopened.repositories.dataDir(added.id), { recursive: true });
  await reopened.call(CHANNELS.repositoriesSwitch, added.id);
  await reopened.call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'login-shell' } }));
  return reopened;
};

test.each(['current session', 'switch back', 'fresh app'] as const)(
  'env: applied configuration recovers scripts-off installation in %s and resumes the original checks',
  async (mode) => {
    const { h: original, work, rounds } = await appliedConfiguration();
    let h = original;
    if (mode === 'switch back') {
      const first = original.repositories.current!.id;
      await h.call(CHANNELS.repositoriesAdd, (await gitRepo({ 'README.md': '# another\n' })).root, true);
      const other = (await h.call(CHANNELS.envGet)).data;
      assert.equal(other.configurationPackage, null);
      assert.deepEqual(other.steps, []);
      await h.call(CHANNELS.repositoriesSwitch, first);
    } else if (mode === 'fresh app') h = await reopenConfiguration(original);
    const calls = h.agentCalls.length;
    const install = (await h.call(CHANNELS.envGet)).data;
    assert.equal(install.configurationPackage.id, work.id);
    assert.equal(install.configurationPackage.installPending, true);
    assert.equal(install.status, 'ready');
    assert.equal(install.stale, false);
    assert.equal(install.allowScripts, false);
    assert.deepEqual(install.plan.scripts, {});
    assert.deepEqual(install.stepKinds, []);
    assert.deepEqual(
      install.steps.map((step) => step.line),
      ['npm install --ignore-scripts --no-audit --no-fund'],
    );
    assert.equal((await h.call(CHANNELS.envSetAllowScripts, true)).error.code, 'env_blocked');
    for (const id of ['test', 'lint', 'rebuild', 'npm install']) assert.equal((await h.call(CHANNELS.envRunStep, id)).error.code, 'invalid_argument');
    assert.equal((await h.call(CHANNELS.envApply, ['test'])).error.code, 'invalid_argument');
    assert.equal((await h.call(CHANNELS.envCreateConfiguration)).error.code, 'invalid_state');
    assert.equal((await h.call(CHANNELS.envRunStep, 'install')).ok, true);
    const installed = (await h.call(CHANNELS.envGet)).data.steps[0].result;
    assert.equal(installed.ok, true, installed.output);
    assert.equal(installed.line, install.steps[0].line);
    await assert.rejects(() => fs.access(path.join(original.root, 'install-marker')));
    await assert.rejects(() => fs.access(path.join(original.root, 'check-marker')));
    assert.equal(h.agentCalls.length, calls, 'restoring and running installation never calls a model');
    assert.equal((await h.call(CHANNELS.codingResume, work.id)).ok, true);
    const resumed = await fixtures.settleReview(h.call, work.id);
    assert.equal(resumed.codingRun.status, 'submitted');
    await fs.access(path.join(original.root, 'check-marker'));
    assert.equal(rounds(), 1);
  },
);

test('env: a direct install click restores the pending configuration, while explicit analysis still calls the steward', async () => {
  const { h: source, work } = await appliedConfiguration();
  const h = await reopenConfiguration(source);
  const calls = h.agentCalls.length;
  assert.equal((await h.call(CHANNELS.envRunStep, 'install')).ok, true);
  assert.equal(h.agentCalls.length, calls);
  assert.equal((await h.call(CHANNELS.codingGet, work.id)).data.codingRun.halt, 'setup_required');
  await h.call(CHANNELS.envPlan);
  const analyzed = await settleEnv(h.call);
  assert.equal(h.agentCalls.length, calls + 1);
  assert.equal(analyzed.plan.scripts.test, 'test');
  assert.ok(analyzed.steps.some((step) => step.id === 'test'));
  assert.equal((await h.call(CHANNELS.envSetAllowScripts, true)).data.allowScripts, true);
});

test('env: recovery coalesces concurrent reads and refuses an install crossing a real repository switch', async () => {
  const { h } = await appliedConfiguration();
  const first = h.repositories.current!.id;
  const calls = h.agentCalls.length;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const probe = typescriptSetup.probe;
  const held = vi.spyOn(typescriptSetup, 'probe').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return probe(...args);
  });
  const other = await gitRepo({ 'README.md': '# another\n' });
  const read = h.call(CHANNELS.envGet);
  const repeated = h.call(CHANNELS.envGet);
  const install = h.call(CHANNELS.envRunStep, 'install');
  const permission = h.call(CHANNELS.envSetAllowScripts, true);
  try {
    await entered.promise;
    assert.equal(held.mock.calls.length, 1);
    await h.call(CHANNELS.repositoriesAdd, other.root, true);
    release.resolve();
    const [readResult, repeatedResult, installResult, permissionResult] = await Promise.all([read, repeated, install, permission]);
    for (const result of [readResult, repeatedResult]) {
      assert.equal(result.ok, true);
      assert.equal(result.data.configurationPackage, null);
      assert.deepEqual(result.data.steps, []);
    }
    assert.equal(installResult.error.code, 'env_stale');
    assert.equal(permissionResult.error.code, 'env_stale');
    assert.equal((await h.call(CHANNELS.envGet)).data.allowScripts, false);
    assert.equal(h.agentCalls.length, calls);
    await assert.rejects(() => fs.access(path.join(other.root, 'package-lock.json')));
    await h.call(CHANNELS.repositoriesSwitch, first);
    const restored = (await h.call(CHANNELS.envGet)).data;
    assert.equal(restored.configurationPackage.installPending, true);
    assert.deepEqual(
      restored.steps.map((step) => step.id),
      ['install'],
    );
  } finally {
    release.resolve();
    await Promise.all([read, repeated, install, permission]);
    held.mockRestore();
  }
});

test('env: recovered installs retain tool blockers and reject a later staged repository edit', async () => {
  const { h: source } = await appliedConfiguration();
  const h = await reopenConfiguration(source, {
    pathResolver: createPathResolver({ inherited: '/missing-tools', discover: async () => [], read: async () => '/missing-tools' }),
  });
  const recovered = (await h.call(CHANNELS.envGet)).data;
  assert.ok(recovered.blockers.includes('node_missing'));
  assert.ok(recovered.blockers.includes('npm_missing'));
  assert.equal((await h.call(CHANNELS.envRunStep, 'install')).error.code, 'env_blocked');
  await fixtures.run('git', ['add', 'package.json'], { cwd: source.root });
  assert.equal((await h.call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await h.call(CHANNELS.envRunStep, 'install')).error.code, 'env_stale');
  assert.equal(h.agentCalls.length, 0);
});

test('env: a failed CLI analysis records its original reason and stderr for diagnostics', async () => {
  const records = expectConsole('error', /\[environment\] analysis failed/);
  const detail = "Invalid schema: 'schema.properties.configuration.oneOf' is not permitted when strict is true.";
  const h = await envHarness({ overrides: { env: new AgentRunError('Codex analysis exited with 1', 'agent_failed', detail) } });
  await h.call(CHANNELS.envPlan);
  const failed = await settleEnv(h.call);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'agent_failed');
  assert.match(failed.error.message, /Codex analysis exited with 1/);
  assert.match(failed.error.message, /configuration.oneOf.*not permitted/);
  assert.equal(records.length, 1);
});

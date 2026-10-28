// IPC channels of the environment domain (src/main/ipc/environment.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

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
  fixtures.until(
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
  assert.deepEqual(view.stepKinds, ['test', 'lint', 'build']);
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
  const live = await fixtures.until(
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
  // A step kind the npm adapter does not plan.
  assert.equal((await call(CHANNELS.envApply, ['typecheck'])).error.code, 'invalid_argument');
  setRoot(os.tmpdir());
  assert.equal((await call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await call(CHANNELS.envRunStep, 'test')).error.code, 'env_stale');
});

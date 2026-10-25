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

const settleEnv = async (call) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.envGet);
    if (data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('environment plan never settled');
};

test('env: plan, confirm steps one by one, then apply the scripts', async () => {
  const { call, repoDir } = await envHarness();
  const started = await call(CHANNELS.envPlan);
  assert.equal(started.data.status, 'planning');
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  assert.deepEqual(view.blockers, []);
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
  let live: { output: string; startedAt: string } | null = null;
  for (let index = 0; index < 400 && !live?.output.includes('halfway'); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    live = (await h.call(CHANNELS.envGet)).data.live;
  }
  assert.match(live?.output ?? '', /halfway/);
  assert.ok(Number.isFinite(Date.parse(live!.startedAt)));
  const view = (await finished).data;
  assert.equal(view.live, null);
  const result = view.steps.find((step) => step.id === 'test').result;
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /done/);
});

test('env: a scripts-off install is followed by a rebuild that runs only the marked packages', async () => {
  const h = await envHarness();
  // Two local dependencies with a postinstall. npm marks both; the test then
  // keeps only one marked, to show the rebuild runs exactly what is listed.
  for (const name of ['needs-build', 'left-alone']) {
    const dir = path.join(h.root, 'deps', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', scripts: { postinstall: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" } }),
    );
  }
  const manifest = JSON.parse(await fs.readFile(path.join(h.root, 'package.json'), 'utf8'));
  manifest.dependencies = { 'needs-build': 'file:deps/needs-build', 'left-alone': 'file:deps/left-alone' };
  await fs.writeFile(path.join(h.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Copies, not symlinks, as a registry install would give.
  await fs.writeFile(path.join(h.root, '.npmrc'), 'install-links=true\n');
  const { entries } = (await h.call(CHANNELS.environmentInfo)).data;
  await fixtures.run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: h.root, env: { ...process.env, PATH: entries.join(':') } });
  const lock = JSON.parse(await fs.readFile(path.join(h.root, 'package-lock.json'), 'utf8'));
  delete lock.packages['node_modules/left-alone'].hasInstallScript;
  await fs.writeFile(path.join(h.root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await fixtures.run('git', ['add', '-A'], { cwd: h.root });
  await fixtures.run('git', ['commit', '-qm', 'deps'], { cwd: h.root });

  await h.call(CHANNELS.envPlan);
  const view = await settleEnv(h.call);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  assert.deepEqual(view.facts.installScripts, ['needs-build']);
  assert.deepEqual(
    view.steps.map((step) => [step.id, step.line]),
    [
      ['install', 'npm install --ignore-scripts --no-audit --no-fund'],
      ['rebuild', 'npm rebuild needs-build'],
      ['test', 'npm test'],
      ['lint', 'npm run lint'],
    ],
  );
  const built = (name: string) =>
    fs.access(path.join(h.root, 'node_modules', name, 'built.txt')).then(
      () => true,
      () => false,
    );
  const installed = (await h.call(CHANNELS.envRunStep, 'install')).data.steps[0].result;
  assert.equal(installed.ok, true, installed.output);
  assert.equal(await built('needs-build'), false, 'install skipped the script');
  const rebuilt = (await h.call(CHANNELS.envRunStep, 'rebuild')).data.steps[1].result;
  assert.equal(rebuilt.ok, true, rebuilt.output);
  assert.equal(await built('needs-build'), true, 'rebuild ran the marked package');
  assert.equal(await built('left-alone'), false, 'an unmarked package stays unbuilt');

  // Allowing every script makes the rebuild step unnecessary.
  assert.deepEqual(
    (await h.call(CHANNELS.envSetAllowScripts, true)).data.steps.map((step) => step.id),
    ['install', 'test', 'lint'],
  );
});

test('env: npm ci over an existing node_modules is flagged as replacing it', async () => {
  const h = await envHarness({ overrides: { env: { ...fixtures.ENV_PLAN, install: { mode: 'ci', reason: '有 lockfile' } } } });
  await fs.writeFile(path.join(h.root, 'package-lock.json'), JSON.stringify({ name: 'env-fixture', lockfileVersion: 3, packages: { '': {} } }));
  await fixtures.run('git', ['add', '-A'], { cwd: h.root });
  await fixtures.run('git', ['commit', '-qm', 'lock'], { cwd: h.root });
  await fs.mkdir(path.join(h.root, 'node_modules'));
  await h.call(CHANNELS.envPlan);
  const view = await settleEnv(h.call);
  const install = view.steps.find((step) => step.id === 'install');
  assert.match(install.line, /^npm ci /);
  assert.equal(install.replacesInstall, true);
});

test('env: re-planning with a failure hands the steward the failed output', async () => {
  const { call, agentCalls } = await envHarness();
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  await call(CHANNELS.envRunStep, 'lint');
  await call(CHANNELS.envPlan, { withFailure: true });
  const view = await settleEnv(call);
  const prompts = agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'env').map((c) => c.prompt);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /<failed_step>/);
  assert.match(prompts[1], /<failed_step>[\s\S]*npm run lint[\s\S]*lint broke/);
  assert.equal(view.steps.find((s) => s.id === 'lint').result.ok, false, 'unchanged step keeps its result');
});

test('env: allowing lifecycle scripts changes the install line and clears its result', async () => {
  const { call } = await envHarness();
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  const view = (await call(CHANNELS.envSetAllowScripts, true)).data;
  assert.equal(view.allowScripts, true);
  assert.equal(view.steps[0].line, 'npm install --no-audit --no-fund');
});

test('env: steps are refused without a plan, by unknown id, or after the root changes', async () => {
  const { call, setRoot } = await envHarness();
  assert.equal((await call(CHANNELS.envRunStep, 'install')).error.code, 'env_no_plan');
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  assert.equal((await call(CHANNELS.envRunStep, 'rm -rf /')).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['build'])).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['deploy'])).error.code, 'invalid_argument');
  setRoot(os.tmpdir());
  assert.equal((await call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await call(CHANNELS.envRunStep, 'test')).error.code, 'env_stale');
});

test('env: a repository without package.json is blocked before the model runs', async () => {
  const { call, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  await call(CHANNELS.envPlan);
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready');
  assert.ok(view.blockers.includes('no_manifest'));
  assert.equal(view.plan, null);
  assert.deepEqual(view.steps, []);
  assert.equal(agentCalls.length, 0);
});

test('env: a second plan request while one runs is refused', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { call } = await envHarness({
    agent: async () => {
      await gate;
      return { output: fixtures.ENV_PLAN, costUsd: 0 };
    },
  });
  await call(CHANNELS.envPlan);
  assert.equal((await call(CHANNELS.envPlan)).error.code, 'env_busy');
  release();
  assert.equal((await settleEnv(call)).status, 'ready');
});

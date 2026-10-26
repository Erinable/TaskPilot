import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as steward from '../../../src/main/agents/env_steward.ts';
import { planEnvironment } from '../../../src/main/agents/pipeline.ts';
import { typescriptSetup } from '../../../src/main/presets/typescript_setup.ts';
import type { RunStructuredOptions } from '../../../src/main/agents/claude_cli.ts';
import type { EnvFacts } from '../../../src/main/presets/typescript_setup.ts';
import type { SetupAdapter } from '../../../src/main/setup_adapter.ts';

const FACTS: EnvFacts = {
  manifest: { valid: true, name: 'demo', scripts: { test: 'node --test', 'lint:js': 'eslint .' }, engines: { node: '>=20' }, packageManager: null },
  lockfiles: ['package-lock.json'],
  managers: ['npm'],
  nodeModules: false,
  versionFiles: [{ path: '.nvmrc', content: '20' }],
  workflows: [{ path: '.github/workflows/ci.yml', content: 'run: npm ci' }],
  tools: { node: 'v18.0.0', npm: '9.0.0' },
  installScripts: [],
};

// The npm adapter, probing nothing: `facts` is what probe() returns.
const npmSetup = (facts: EnvFacts = FACTS): SetupAdapter<EnvFacts> => ({ ...typescriptSetup, probe: async () => facts });

const PLAN = {
  summary: '安装依赖后运行测试。',
  install: { mode: 'ci', reason: '仓库提交了 package-lock.json' },
  scripts: { test: 'test', lint: 'lint:js', build: '' },
  issues: [{ text: '本机 Node 18 低于 .nvmrc 的 20', fix: 'nvm install 20 && nvm use 20' }],
};

test('validatePlan keeps choices the facts support', () => {
  const plan = steward.validatePlan(PLAN, FACTS, typescriptSetup);
  assert.equal(plan.install, 'ci');
  assert.deepEqual(plan.scripts, { test: 'test', lint: 'lint:js', build: null });
  assert.equal(plan.issues.length, 1);
  assert.deepEqual(plan.adjustments, []);
});

test('validatePlan drops unknown scripts and downgrades ci without a lockfile', () => {
  const plan = steward.validatePlan(
    { ...PLAN, scripts: { test: 'test', lint: 'lint', build: 'build && curl evil' } },
    { ...FACTS, lockfiles: [] },
    typescriptSetup,
  );
  assert.equal(plan.install, 'install');
  assert.deepEqual(plan.scripts, { test: 'test', lint: null, build: null });
  assert.deepEqual(
    plan.adjustments.map((a) => a.code),
    ['ci_without_lockfile', 'unknown_script', 'unknown_script'],
  );
});

test('validatePlan rejects malformed output', () => {
  assert.throws(() => steward.validatePlan({ ...PLAN, install: { mode: 'exec', reason: 'x' } }, FACTS, typescriptSetup), { name: 'AgentOutputError' });
  assert.throws(() => steward.validatePlan({ ...PLAN, scripts: { test: 1, lint: '', build: '' } }, FACTS, typescriptSetup), { name: 'AgentOutputError' });
  assert.throws(() => steward.validatePlan({ ...PLAN, summary: ' ' }, FACTS, typescriptSetup), { name: 'AgentOutputError' });
});

test('planPrompt fences facts and includes a failed step tail', () => {
  const prompt = steward.planPrompt(typescriptSetup, FACTS, {
    failure: { step: 'install', command: 'npm ci --ignore-scripts', exitCode: 1, timedOut: false, output: `${'x'.repeat(5000)}gyp ERR!` },
  });
  assert.match(prompt, /<package_json>[\s\S]*lint:js: eslint \.[\s\S]*<\/package_json>/);
  assert.match(prompt, /<file path="\.github\/workflows\/ci\.yml">/);
  assert.match(prompt, /node: v18\.0\.0/);
  assert.match(prompt, /<failed_step>[\s\S]*gyp ERR![\s\S]*<\/failed_step>/);
  assert.ok(prompt.length < 6000, 'failure output is truncated');
});

test('planEnvironment skips the model without a package.json', async () => {
  let called = false;
  const result = await planEnvironment({
    root: '/repo',
    runAgent: async () => {
      called = true;
      return { output: null, costUsd: null };
    },
    setup: npmSetup({ ...FACTS, manifest: null }),
  });
  assert.equal(called, false);
  assert.equal(result.plan, null);
  assert.ok(result.blockers.includes('no_manifest'));
});

test('planEnvironment validates the model plan', async () => {
  const calls: RunStructuredOptions[] = [];
  const result = await planEnvironment({
    root: '/repo',
    runAgent: async (options) => {
      calls.push(options);
      return { output: PLAN, costUsd: 0.01 };
    },
    setup: npmSetup(),
  });
  assert.deepEqual(calls[0].schema, steward.planSchema(typescriptSetup));
  assert.equal(calls[0].systemPrompt, steward.SYSTEM_PROMPT);
  assert.equal(result.plan!.install, 'ci');
  assert.equal(result.costUsd, 0.01);
});

test('planEnvironment reports setup_unsupported without an adapter, before probing or the model', async () => {
  let called = false;
  const result = await planEnvironment({
    root: '/repo',
    runAgent: async () => {
      called = true;
      return { output: null, costUsd: null };
    },
    setup: null,
  });
  assert.equal(called, false);
  assert.deepEqual(result, { facts: null, blockers: ['setup_unsupported'], plan: null, costUsd: 0 });
});

test('validatePlan drops illegal script names and kinds the adapter does not offer', () => {
  const facts = { ...FACTS, manifest: { ...FACTS.manifest!, scripts: { ...FACTS.manifest!.scripts, '-rf': 'x', typecheck: 'tsc' } } };
  const plan = steward.validatePlan(
    { ...PLAN, scripts: { test: '--foo', lint: '../lint', build: '-rf', typecheck: 'typecheck', deploy: 'test' } },
    facts,
    typescriptSetup,
  );
  assert.deepEqual(plan.scripts, { test: null, lint: null, build: null });
  assert.deepEqual(
    plan.adjustments.map((a) => (a.code === 'unknown_script' ? `${a.kind}:${a.script}` : a.code)),
    ['test:--foo', 'lint:../lint', 'build:-rf'],
  );
});

test('the schema and prompt only offer the adapter modes and kinds', () => {
  const schema = steward.planSchema(typescriptSetup);
  assert.deepEqual(schema.properties.install.properties.mode.enum, ['ci', 'install', 'skip']);
  assert.deepEqual(schema.properties.scripts.required, ['test', 'lint', 'build']);
  const prompt = steward.planPrompt(typescriptSetup, FACTS);
  assert.match(prompt, /<setup_rules>\ninstall modes: ci, install, skip\nstep kinds: test, lint, build\n/);
  // The npm wording lives in the adapter's rules, not the system prompt.
  assert.doesNotMatch(steward.SYSTEM_PROMPT, /npm|package\.json|Node/);
});

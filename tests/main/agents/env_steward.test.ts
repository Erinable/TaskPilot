import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as steward from '../../../src/main/agents/env_steward.ts';
import { planEnvironment } from '../../../src/main/agents/pipeline.ts';
import type { RunStructuredOptions } from '../../../src/main/agents/claude_cli.ts';

const FACTS = {
  manifest: { valid: true, name: 'demo', scripts: { test: 'node --test', 'lint:js': 'eslint .' }, engines: { node: '>=20' }, packageManager: null },
  lockfiles: ['package-lock.json'],
  managers: ['npm'],
  nodeModules: false,
  versionFiles: [{ path: '.nvmrc', content: '20' }],
  workflows: [{ path: '.github/workflows/ci.yml', content: 'run: npm ci' }],
  tools: { node: 'v18.0.0', npm: '9.0.0' },
};

const PLAN = {
  summary: '安装依赖后运行测试。',
  install: { mode: 'ci', reason: '仓库提交了 package-lock.json' },
  scripts: { test: 'test', lint: 'lint:js', build: '' },
  issues: [{ text: '本机 Node 18 低于 .nvmrc 的 20', fix: 'nvm install 20 && nvm use 20' }],
};

test('validatePlan keeps choices the facts support', () => {
  const plan = steward.validatePlan(PLAN, FACTS);
  assert.equal(plan.install, 'ci');
  assert.deepEqual(plan.scripts, { test: 'test', lint: 'lint:js', build: null });
  assert.equal(plan.issues.length, 1);
  assert.deepEqual(plan.adjustments, []);
});

test('validatePlan drops unknown scripts and downgrades ci without a lockfile', () => {
  const plan = steward.validatePlan(
    { ...PLAN, scripts: { test: 'test', lint: 'lint', build: 'build && curl evil' } },
    { ...FACTS, lockfiles: [] },
  );
  assert.equal(plan.install, 'install');
  assert.deepEqual(plan.scripts, { test: 'test', lint: null, build: null });
  assert.deepEqual(plan.adjustments.map((a) => a.code), ['ci_without_lockfile', 'unknown_script', 'unknown_script']);
});

test('validatePlan rejects malformed output', () => {
  assert.throws(() => steward.validatePlan({ ...PLAN, install: { mode: 'exec', reason: 'x' } }, FACTS), { name: 'AgentOutputError' });
  assert.throws(() => steward.validatePlan({ ...PLAN, scripts: { test: 1, lint: '', build: '' } }, FACTS), { name: 'AgentOutputError' });
  assert.throws(() => steward.validatePlan({ ...PLAN, summary: ' ' }, FACTS), { name: 'AgentOutputError' });
});

test('planPrompt fences facts and includes a failed step tail', () => {
  const prompt = steward.planPrompt(FACTS, {
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
    runAgent: async () => { called = true; return { output: null, costUsd: null }; },
    probe: async () => ({ ...FACTS, manifest: null }),
  });
  assert.equal(called, false);
  assert.equal(result.plan, null);
  assert.ok(result.blockers.includes('no_manifest'));
});

test('planEnvironment validates the model plan', async () => {
  const calls: RunStructuredOptions[] = [];
  const result = await planEnvironment({
    root: '/repo',
    runAgent: async (options) => { calls.push(options); return { output: PLAN, costUsd: 0.01 }; },
    probe: async () => FACTS,
  });
  assert.equal(calls[0].schema, steward.PLAN_SCHEMA);
  assert.equal(calls[0].systemPrompt, steward.SYSTEM_PROMPT);
  assert.equal(result.plan!.install, 'ci');
  assert.equal(result.costUsd, 0.01);
});

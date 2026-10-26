// [人工决策-2026-10-26 13:15:53] vitest 仓库读 JUnit 报告判定测试结果，与 pytest 一致（CARM-22 方案 1）。
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as effectiveSteps from '../../../src/main/effective_steps.ts';
import * as evidence from '../../../src/main/evidence.ts';
import * as verification from '../../../src/main/verification.ts';
import * as workspace from '../../../src/main/workspace.ts';
import { VITEST_REPORT, runsVitestAlone, typescriptPreset } from '../../../src/main/presets/typescript.ts';
import { parseManifest } from '../../../src/main/presets/typescript_setup.ts';
import type { CheckStep } from '../../../src/main/step_config.ts';

const run = promisify(execFile);
const REPO = path.join(import.meta.dirname, '../../..');
const FIXTURES = path.join(import.meta.dirname, '../fixtures');
const CHECK = { kind: 'test', stage: 'submit', blocking: true } as const;
const testOf = (script: string) => typescriptPreset.steps({ manifest: parseManifest(JSON.stringify({ scripts: { test: script } })) }).test;

const JUNIT_STEP = {
  commands: [{ command: 'npm', args: ['test', '--', '--reporter=default', '--reporter=junit', `--outputFile=${VITEST_REPORT}`] }],
  parser: { format: 'junit', path: VITEST_REPORT },
};

test('a test script that is vitest alone reads its JUnit report', async () => {
  for (const script of ['vitest', 'vitest run', 'npx vitest', 'npx vitest run --passWithNoTests']) assert.deepEqual(testOf(script), JUNIT_STEP, script);
  // TaskPilot's own taskpilot.toml (preset = typescript) gets it too.
  const manifest = parseManifest(await fs.readFile(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(typescriptPreset.steps({ manifest }).test, JUNIT_STEP);
});

test('any other test script keeps the step it had before', () => {
  const before = { commands: [{ command: 'npm', args: ['test'] }], parser: { format: 'tests' } };
  for (const script of [
    'node --test',
    'jest',
    'a && vitest run',
    'vitest run && a',
    'vitest run; a',
    'vitest run | tee out',
    'CI=1 vitest run',
    'vitest bench',
    'vitest src',
    'vitest --reporter=dot',
    'vitest run --outputFile.junit=x.xml',
    'vitest --watch',
    'vitest -w',
  ]) {
    assert.equal(runsVitestAlone(script), false, script);
    assert.deepEqual(testOf(script), before, script);
  }
});

// End to end on tests/main/fixtures/typescript_sample through TaskPilot's own
// runner, with this repository's node_modules linked in for vitest.
const fixtureRepo = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-typescript-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(FIXTURES, 'typescript_sample'), root, { recursive: true });
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "typescript"\n');
  await fs.symlink(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const g = (args: string[]) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return root;
};

const criteria = (result: verification.CheckRun, names: string[]) =>
  evidence
    .criteriaStatus(
      names.map((name) => ({ text: name, test: name })),
      { test: result },
      [evidence.evaluate(CHECK, result, null)],
    )
    .map((criterion) => criterion.status);

const NAMES = ['auth > login > locks after five failures', 'auth > login > rejects a bad password', 'exports login'];

test('vitest results come from the JUnit report: linked tests are verified or failed, never missing', async () => {
  const root = await fixtureRepo();
  const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: {} }));
  assert.deepEqual(resolution.project, { status: 'ok', preset: 'typescript' });
  const step = effectiveSteps.runnable(resolution).find((entry) => entry.id === 'test') as CheckStep;
  assert.deepEqual(step.parser, { format: 'junit', path: VITEST_REPORT });

  const result = await verification.runStep(root, step);
  assert.equal(result.exitCode, 1, result.output);
  assert.deepEqual(result.report, { format: 'junit', trusted: true, problem: null });
  assert.deepEqual(criteria(result, NAMES), ['verified', 'failed', 'verified']);
  // The default reporter still prints for the developer.
  assert.match(result.output, /Tests {2}1 failed \| 2 passed/);
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  assert.equal(stdout, '');

  // A run that writes no new report (vitest cannot load its config) leaves
  // the old one stale: linked tests are unverifiable, not missing.
  await fs.writeFile(path.join(root, 'vitest.config.ts'), "throw new Error('broken config');\n");
  const broken = await verification.runStep(root, step);
  assert.notEqual(broken.exitCode, 0);
  assert.deepEqual(broken.report, { format: 'junit', trusted: false, problem: 'stale' });
  assert.deepEqual(criteria(broken, NAMES), ['unverifiable', 'unverifiable', 'unverifiable']);
  await fs.rm(path.join(root, '.taskpilot'), { recursive: true });
  const missing = await verification.runStep(root, step);
  assert.deepEqual(missing.report, { format: 'junit', trusted: false, problem: 'missing' });
  assert.deepEqual(criteria(missing, NAMES), ['unverifiable', 'unverifiable', 'unverifiable']);
}, 120_000);

import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as effectiveSteps from '../../src/main/effective_steps.ts';
import * as workspace from '../../src/main/workspace.ts';
import { detectLanguages } from '../../src/main/presets/index.ts';
import { typescriptPreset } from '../../src/main/presets/typescript.ts';
import { parseManifest } from '../../src/main/presets/typescript_setup.ts';
import type { StepPatch } from '../../src/main/step_config.ts';

const run = promisify(execFile);
const npm = (...args: string[]) => ({ command: 'npm', args });

const repo = async (files: Record<string, string>) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-steps-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const g = (args: string[]) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return root;
};

const PACKAGE = JSON.stringify({
  name: 'app',
  scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build', 'format:check': 'prettier --check .' },
});

test('mergeStep() lets a higher layer override only the fields it sets', () => {
  const preset: StepPatch = { commands: [npm('run', 'lint')], parser: { format: 'exitcode' }, timeoutMs: 60000 };
  const project: StepPatch = { blocking: true, stage: 'submit' };
  const local: StepPatch = { commands: [npm('run', 'lint:fast')] };
  const resolved = effectiveSteps.mergeStep('lint', [
    { source: 'preset', steps: { lint: preset } },
    { source: 'project', steps: { lint: project } },
    { source: 'local', steps: { lint: local } },
  ]);
  assert.equal(resolved.source, 'local');
  assert.deepEqual(resolved.step, {
    id: 'lint',
    label: null,
    commands: [npm('run', 'lint:fast')],
    cwd: '',
    stage: 'submit',
    blocking: true,
    parser: { format: 'exitcode' },
    env: {},
    timeoutMs: 60000,
  });
});

test('enabled = false turns a step off; a higher layer can turn it back on', () => {
  const preset = { source: 'preset' as const, steps: { coverage: { commands: [npm('run', 'coverage')] } } };
  const off = { source: 'project' as const, steps: { coverage: { enabled: false } } };
  assert.deepEqual(effectiveSteps.mergeStep('coverage', [preset, off]), { id: 'coverage', step: null, source: 'project', skipped: 'disabled' });
  const on = { source: 'local' as const, steps: { coverage: { enabled: true } } };
  assert.equal(effectiveSteps.mergeStep('coverage', [preset, off, on]).step?.commands[0].args[1], 'coverage');
});

test('a step no layer gives commands is listed as skipped, in the fixed order', () => {
  const steps = effectiveSteps.mergeSteps(
    [{ source: 'local', steps: { 'custom:b': { commands: [npm('x')] }, test: { commands: [npm('test')] } } }],
    ['setup', 'lint'],
  );
  assert.deepEqual(
    steps.map((entry) => [entry.id, entry.skipped]),
    [
      ['setup', 'not_configured'],
      ['lint', 'not_configured'],
      ['test', null],
      ['custom:b', null],
    ],
  );
  // Steps take their own defaults: only tests run before review and reject.
  assert.deepEqual([steps[2].step?.stage, steps[2].step?.blocking, steps[3].step?.stage, steps[3].step?.blocking], ['submit', true, 'step', false]);
});

// The regression the migration must not cause: a TS repository that has
// not opted in keeps exactly the steps it configured on this machine.
test('a TypeScript repository without taskpilot.toml runs only the local steps', async () => {
  const root = await repo({ 'package.json': PACKAGE });
  const config = workspace.normalize({ version: 2, root, checks: { test: { command: 'npm', args: ['test'] } } });
  const resolution = await effectiveSteps.resolve(config);
  assert.deepEqual(resolution.project, { status: 'missing' });
  assert.deepEqual(
    effectiveSteps.runnable(resolution).map((step) => [step.id, step.commands, step.stage, step.blocking, step.parser]),
    [['test', [npm('test')], 'submit', true, { format: 'tests' }]],
  );
  // The preset is recommended and offers its commands, but adds none.
  assert.deepEqual(resolution.detected, [{ manifest: 'package.json', language: 'TypeScript / JavaScript', preset: 'typescript' }]);
  assert.deepEqual(resolution.suggestions.lint, ['npm run lint', 'npx eslint .']);
});

test('taskpilot.toml with the typescript preset fills the steps from package.json scripts', async () => {
  const root = await repo({
    'package.json': PACKAGE,
    'taskpilot.toml':
      'preset = "typescript"\n[steps.lint]\nrequired = true\n[steps.coverage]\nenabled = false\n[custom.complexity]\ncommands = ["node scripts/c.ts --check"]\n',
  });
  const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: { build: { enabled: false } } }), { always: ['coverage'] });
  assert.deepEqual(resolution.project, { status: 'ok', preset: 'typescript' });
  const byId = Object.fromEntries(resolution.steps.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.setup.step?.commands, [npm('ci', '--ignore-scripts', '--no-audit', '--no-fund')]);
  assert.deepEqual(byId.lint.step?.commands, [npm('run', '--silent', 'lint')]);
  assert.equal(byId.lint.step?.blocking, true);
  assert.equal(byId.lint.source, 'project');
  assert.equal(byId.typecheck.step?.parser.format, 'regex');
  assert.deepEqual(byId.format.step?.commands, [npm('run', '--silent', 'format:check')]);
  assert.deepEqual(byId.test.step?.commands, [npm('test')]);
  assert.equal(byId.build.skipped, 'disabled');
  assert.equal(byId.build.source, 'local');
  assert.equal(byId.coverage.skipped, 'disabled');
  assert.equal(byId['custom:complexity'].step?.parser.format, 'tests');
});

test('a broken taskpilot.toml is reported and ignored, so local steps still run', async () => {
  const root = await repo({ 'taskpilot.toml': '[steps.lint]\nparser = { format = "xml" }\n' });
  const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: { test: { commands: ['npm test'] } } }));
  assert.equal(resolution.project.status, 'invalid');
  assert.equal(resolution.project.status === 'invalid' && resolution.project.error.field, 'steps.lint.parser.format');
  assert.deepEqual(
    effectiveSteps.runnable(resolution).map((step) => step.id),
    ['test'],
  );
});

test('detectLanguages() recognises package.json, Cargo.toml and pyproject.toml', () => {
  assert.deepEqual(
    detectLanguages(new Set(['Cargo.toml', 'pyproject.toml', 'package.json'])).map((entry) => [entry.manifest, entry.preset]),
    [
      ['package.json', 'typescript'],
      ['Cargo.toml', 'rust'],
      ['pyproject.toml', 'python'],
    ],
  );
  assert.deepEqual(detectLanguages(new Set(['README.md'])), []);
});

test('the typescript preset picks scripts by name and parses tsc for typecheck', () => {
  const steps = typescriptPreset.steps({
    manifest: parseManifest(JSON.stringify({ scripts: { test: 'node --test', 'type-check': 'tsc', 'test:coverage': 'c8 npm test' } })),
  });
  assert.deepEqual(Object.keys(steps).sort(), ['coverage', 'setup', 'test', 'typecheck']);
  assert.deepEqual(steps.typecheck?.commands, [npm('run', '--silent', 'type-check')]);
  assert.deepEqual(typescriptPreset.steps({ manifest: null }), {});
});

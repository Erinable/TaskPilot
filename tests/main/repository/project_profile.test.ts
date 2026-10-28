/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { buildProfile } from '../../../src/main/repository/project_profile.ts';
import { createAppContext } from '../../../src/main/app/app_context.ts';
import { createPathResolver } from '../../../src/main/infrastructure/shell_env.ts';
import * as effectiveSteps from '../../../src/main/checking/effective_steps.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';
import { BUILTIN } from '../../fixtures/builtin_courses.ts';
import { pythonPreset } from '../../../src/main/checking/presets/python.ts';
import { VITEST_REPORT, typescriptPreset } from '../../../src/main/checking/presets/typescript.ts';
import { WorkPackageStore } from '../../../src/main/work_packages/work_package_store.ts';
import { RepositoryRegistry } from '../../../src/main/repository/repositories.ts';

const run = promisify(execFile);

const repo = async (files: Record<string, string>) => {
  const root = await fs.realpath(await tempDir('taskpilot-profile-'));
  const g = (args: string[]) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return root;
};

const PACKAGE = JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } });
const resolveIn = (root: string) => effectiveSteps.resolve(workspace.normalize({ root }), { envPath: '/usr/bin:/bin' });

test('buildProfile() describes a TypeScript repository from its preset and steps', async () => {
  const root = await repo({ 'package.json': PACKAGE, 'taskpilot.toml': 'preset = "typescript"\n[steps.lint]\nstage = "submit"\n' });
  const profile = buildProfile(await resolveIn(root));
  assert.deepEqual(profile.languages, [{ id: 'typescript', label: 'TypeScript / JavaScript' }]);
  assert.deepEqual(profile.manifests, ['package.json']);
  assert.deepEqual(
    profile.checks.map(({ id, stage, blocking, reports, commandLine }) => ({ id, stage, blocking, reports, commandLine })),
    [
      { id: 'setup', stage: 'manual', blocking: false, reports: 'exit', commandLine: profile.checks[0].commandLine },
      { id: 'lint', stage: 'submit', blocking: false, reports: 'exit', commandLine: 'npm run --silent lint' },
      { id: 'typecheck', stage: 'manual', blocking: false, reports: 'diagnostics', commandLine: 'npm run --silent typecheck' },
      {
        id: 'test',
        stage: 'submit',
        blocking: true,
        reports: 'tests',
        commandLine: `npm test -- --reporter=default --reporter=junit --outputFile=${VITEST_REPORT}`,
      },
    ],
  );
  assert.match(profile.testLayout ?? '', /\*\.test\.ts/);
  assert.equal(profile.testNameFormat, typescriptPreset.testNameFormat);
  assert.equal(profile.version, null);
});

test('buildProfile() reports junit and JSON steps of a Python repository', async () => {
  const root = await repo({ 'pyproject.toml': '[project]\nname = "app"\n', 'taskpilot.toml': 'preset = "python"\n' });
  const profile = buildProfile(await resolveIn(root));
  assert.deepEqual(profile.languages, [{ id: 'python', label: 'Python' }]);
  assert.deepEqual(profile.manifests, ['pyproject.toml', 'requirements.txt', 'setup.py']);
  const reports = Object.fromEntries(profile.checks.map((check) => [check.id, check.reports]));
  assert.equal(reports.test, 'tests');
  assert.equal(reports.lint, 'diagnostics');
  assert.match(profile.testLayout ?? '', /test_\*\.py/);
  assert.equal(profile.testNameFormat, pythonPreset.testNameFormat);
});

test('buildProfile() without taskpilot.toml lists only the detected languages and local steps', async () => {
  const root = await repo({ 'Cargo.toml': '[package]\nname = "app"\n', 'requirements.txt': '' });
  const resolution = await effectiveSteps.resolve(
    workspace.normalize({ root, version: workspace.CONFIG_VERSION, steps: { test: { commands: [{ command: 'cargo', args: ['test'] }] } } }),
    { envPath: '/usr/bin:/bin' },
  );
  const profile = buildProfile(resolution);
  assert.deepEqual(
    profile.languages.map((language) => language.id),
    ['rust', 'python'],
  );
  assert.deepEqual(profile.manifests, ['Cargo.toml', 'requirements.txt']);
  // Two languages, so no single test layout to name.
  assert.equal(profile.testLayout, null);
  assert.deepEqual(
    profile.checks.map((check) => [check.id, check.label, check.commandLine]),
    [['test', 'Unit tests', 'cargo test']],
  );
  // No preset names the runner, so there is no test name format.
  assert.equal(profile.testNameFormat, null);
});

test('buildProfile() names a custom step by its label', () => {
  const step = {
    id: 'custom:docs' as const,
    label: '文档',
    commands: [{ command: 'node', args: ['docs.js'] }],
    cwd: '',
    stage: 'step' as const,
    blocking: false,
    parser: { format: 'exitcode' as const },
    env: {},
  };
  const profile = buildProfile({
    steps: [{ id: step.id, step, source: 'project', skipped: null }],
    project: { status: 'missing' },
    detected: [],
    suggestions: {},
  });
  assert.deepEqual(profile.checks, [{ id: 'custom:docs', label: '文档', stage: 'manual', blocking: false, commandLine: 'node docs.js', reports: 'exit' }]);
});

test('AppContext.profile() is cached until taskpilot.toml changes', async () => {
  const root = await repo({ 'package.json': PACKAGE });
  let config = workspace.normalize({ root });
  let reads = 0;
  const pathResolver = createPathResolver({ inherited: '/usr/bin:/bin', read: async () => '/usr/bin:/bin' });
  const resolve = pathResolver.resolve.bind(pathResolver);
  const ctx = createAppContext({
    store: new WorkPackageStore(root),
    configDir: root,
    builtinCourses: BUILTIN,
    repositories: new RepositoryRegistry(root),
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    pathResolver: {
      ...pathResolver,
      resolve: (source) => {
        reads += 1;
        return resolve(source);
      },
    },
  });

  const first = await ctx.profile();
  assert.deepEqual(first?.languages, [{ id: 'typescript', label: 'TypeScript / JavaScript' }]);
  assert.deepEqual(first?.checks, []);
  assert.equal(await ctx.profile(), first);

  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "typescript"\n');
  const edited = await ctx.profile();
  assert.notEqual(edited, first);
  assert.deepEqual(
    edited?.checks.map((check) => check.id),
    ['setup', 'lint', 'typecheck', 'test'],
  );

  config = workspace.normalize({ root: null });
  assert.equal(await ctx.profile(), null);
  assert.ok(reads > 0);
});

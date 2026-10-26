import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildProfile } from '../../src/main/project_profile.ts';
import { createAppContext } from '../../src/main/app_context.ts';
import { createPathResolver } from '../../src/main/shell_env.ts';
import { profileBlock } from '../../src/main/agents/prompt_blocks.ts';
import * as productLead from '../../src/main/agents/product_lead.ts';
import * as tutor from '../../src/main/agents/tutor.ts';
import * as effectiveSteps from '../../src/main/effective_steps.ts';
import * as workspace from '../../src/main/workspace.ts';
import { PROGRAMMING_COURSE } from '../../src/shared/course_pack.ts';
import type { AppDeps } from '../../src/main/app_context.ts';
import type { ProjectProfile } from '../../src/shared/project_profile.ts';

const run = promisify(execFile);

const repo = async (files: Record<string, string>) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-profile-')));
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
      { id: 'test', stage: 'submit', blocking: true, reports: 'tests', commandLine: 'npm test' },
    ],
  );
  assert.equal(profile.testLayout, null);
  assert.equal(profile.testNameFormat, null);
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
  assert.deepEqual(
    profile.checks.map((check) => [check.id, check.label, check.commandLine]),
    [['test', 'test', 'cargo test']],
  );
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

const PROFILE: ProjectProfile = {
  languages: [{ id: 'python', label: 'Python' }],
  manifests: ['pyproject.toml'],
  testLayout: 'tests/ 下 test_*.py',
  testNameFormat: 'pytest node id: path::func',
  checks: [{ id: 'test', label: 'test', stage: 'submit', blocking: true, commandLine: 'uv run pytest', reports: 'tests' }],
  version: { file: 'pyproject.toml', value: null },
};

test('profileBlock() renders only the named sections, and nothing without a profile', () => {
  assert.deepEqual(profileBlock(null, ['languages']), []);
  assert.deepEqual(profileBlock(undefined, ['languages']), []);
  assert.deepEqual(profileBlock(PROFILE, []), []);
  assert.deepEqual(profileBlock({ ...PROFILE, testLayout: null }, ['testLayout']), []);
  assert.deepEqual(profileBlock(PROFILE, ['languages', 'testNameFormat', 'checks', 'version']), [
    '',
    '<project_profile>',
    'Languages: Python',
    'Test names: pytest node id: path::func',
    'Checks:',
    '- test (runs before review, blocking, test results): uv run pytest',
    'Version: (none) (from pyproject.toml)',
    '</project_profile>',
  ]);
});

// [人工决策-2026-10-25 23:51:35] 课程包本期只做结构不切换读取：内置包必须与 prompt 原文一致，T7 切换时才能零变化。
test('the built-in programming course pack is the text Product Lead and Tutor use today', () => {
  const plan = productLead.planPrompt({ text: 'x', files: [], linkTests: true });
  assert.ok(productLead.SYSTEM_PROMPT.includes(`plan software work for ${PROGRAMMING_COURSE.learner}.`));
  assert.ok(plan.includes([`Difficulty, for ${PROGRAMMING_COURSE.learner}:`, ...PROGRAMMING_COURSE.difficultyGuide].join('\n')));
  assert.ok(plan.includes(PROGRAMMING_COURSE.practiceGuide.join('\n')));
  assert.ok(tutor.GRADE_SYSTEM_PROMPT.includes(`a desktop app where ${PROGRAMMING_COURSE.learner} practises`));
  assert.ok(
    tutor.GRADE_SYSTEM_PROMPT.includes(`- Mark three things. ${PROGRAMMING_COURSE.rubric.map((item) => `${item.id}: ${item.description}.`).join(' ')}`),
  );
  assert.deepEqual(
    PROGRAMMING_COURSE.rubric.map((item) => item.id),
    [...tutor.GRADE_CATEGORIES],
  );
});

test('AppContext.profile() is cached until taskpilot.toml changes', async () => {
  const root = await repo({ 'package.json': PACKAGE });
  let config = workspace.normalize({ root });
  let reads = 0;
  const pathResolver = createPathResolver({ inherited: '/usr/bin:/bin', read: async () => '/usr/bin:/bin' });
  const resolve = pathResolver.resolve.bind(pathResolver);
  const ctx = createAppContext({
    store: null,
    configDir: root,
    repositories: null,
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
  } as unknown as AppDeps);

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

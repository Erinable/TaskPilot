import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import * as projectConfig from '../../../src/main/repository/project_config.ts';

const PRESETS = ['typescript'];
const parse = (text: string) => projectConfig.parseProject(text, PRESETS);
const fails = (text: string, field: string) => assert.throws(() => parse(text), { code: 'invalid_project', field }, field);

test('a full file parses into step patches, with only the fields it sets', () => {
  const file = parse(`
preset = "typescript"

[steps.lint]
commands = ["npm run lint", ["npx", "prettier", "--check", "."]]
cwd = "packages/app"
timeout = 120
required = true
stage = "submit"
parser = { format = "json", dialect = "eslint", path = "reports/eslint.json" }
env = { CI = "1" }

[steps.coverage]
enabled = false

[custom.complexity]
label = "复杂度"
commands = ["node scripts/analyze_complexity.ts --check"]
parser = "exitcode"
`);
  assert.equal(file.preset, 'typescript');
  assert.deepEqual(file.steps.lint, {
    commands: [
      { command: 'npm', args: ['run', 'lint'] },
      { command: 'npx', args: ['prettier', '--check', '.'] },
    ],
    cwd: 'packages/app',
    timeoutMs: 120000,
    blocking: true,
    stage: 'submit',
    parser: { format: 'json', dialect: 'eslint', path: 'reports/eslint.json' },
    env: { CI: '1' },
  });
  assert.deepEqual(file.steps.coverage, { enabled: false });
  assert.deepEqual(file.steps['custom:complexity'], {
    commands: [{ command: 'node', args: ['scripts/analyze_complexity.ts', '--check'] }],
    parser: { format: 'exitcode' },
    label: '复杂度',
  });
});

test('no preset and "none" both mean no preset', () => {
  assert.equal(parse('').preset, null);
  assert.equal(parse('preset = "none"').preset, null);
  assert.deepEqual(parse('').steps, {});
});

test('every mistake names the field at fault', () => {
  fails('preset = "cobol"', 'preset');
  fails('version = 2', 'version');
  fails('presets = "typescript"', 'presets');
  fails('[steps.deploy]\ncommands = ["x"]', 'steps.deploy');
  fails('[steps.lint]\ncommand = "eslint ."', 'steps.lint.command');
  fails('[steps.lint]\ncommands = []', 'steps.lint.commands');
  fails('[steps.lint]\ncommands = 3', 'steps.lint.commands');
  fails('[steps.lint]\ncommands = ["eslint . && prettier ."]', 'steps.lint.commands[0]');
  fails('[steps.lint]\ncommands = ["eslint \'unterminated"]', 'steps.lint.commands[0]');
  fails('[steps.lint]\ntimeout = 0', 'steps.lint.timeout');
  fails('[steps.lint]\ntimeout = 1.5', 'steps.lint.timeout');
  fails('[steps.lint]\nrequired = "yes"', 'steps.lint.required');
  fails('[steps.lint]\nstage = "step"', 'steps.lint.stage');
  fails('[steps.lint]\ncwd = "../elsewhere"', 'steps.lint.cwd');
  fails('[steps.lint]\ncwd = "/abs"', 'steps.lint.cwd');
  fails('[steps.lint]\nparser = { format = "xml" }', 'steps.lint.parser.format');
  fails('[steps.lint]\nparser = { format = "json", dialect = "pylint" }', 'steps.lint.parser.dialect');
  fails('[steps.lint]\nparser = { format = "json", schema = "x" }', 'steps.lint.parser.schema');
  fails('[steps.test]\nparser = { format = "junit" }', 'steps.test.parser.path');
  fails('[steps.lint]\nparser = { format = "regex", pattern = "(" }', 'steps.lint.parser.pattern');
  fails('[steps.lint]\nparser = { format = "regex", pattern = "x", severity = "fatal" }', 'steps.lint.parser.severity');
  fails('[steps.lint]\nenv = { PATH = "/evil" }', 'steps.lint.env.PATH');
  fails('[custom.Bad]\ncommands = ["x"]', 'custom.Bad');
  fails('[custom.smoke]\nlabel = "Smoke"', 'custom.smoke.commands');
  fails('[custom.smoke]\ncommands = ["x"]\nlabel = 3', 'custom.smoke.label');
});

test('a TOML syntax error names its line and column', () => {
  assert.throws(
    () => parse('preset = "typescript"\n[steps.lint\n'),
    (error: Error & { field?: string }) => {
      assert.equal(error.field, 'toml');
      assert.match(error.message, /^line 2, column \d+:/);
      return true;
    },
  );
});

test('the file is read only as a regular file in the root, and created only when absent', async () => {
  const root = await tempDir('taskpilot-project-');
  assert.equal(await projectConfig.readProjectText(root), null);
  await projectConfig.createProjectFile(root, 'typescript', { lint: 'npm run lint', custom: null });
  const text = await projectConfig.readProjectText(root);
  assert.equal(parse(text as string).preset, 'typescript');
  await assert.rejects(() => projectConfig.createProjectFile(root, 'none', { lint: null, custom: null }), { code: 'invalid_project' });

  const linked = await tempDir('taskpilot-project-link-');
  await fs.symlink(path.join(root, projectConfig.PROJECT_FILENAME), path.join(linked, projectConfig.PROJECT_FILENAME));
  await assert.rejects(() => projectConfig.readProjectText(linked), { code: 'invalid_project', field: 'toml' });
});

test("the template shows the preset's own example commands, quoted for TOML", () => {
  const rust = projectConfig.projectTemplate('rust', { lint: 'cargo clippy --workspace', custom: 'cargo check --workspace' });
  assert.match(rust, /^# commands = \["cargo clippy --workspace"\]$/m);
  assert.match(rust, /^# commands = \["cargo check --workspace"\]$/m);
  assert.doesNotMatch(rust, /npm|node /);
  const none = projectConfig.projectTemplate('none', { lint: null, custom: null });
  assert.equal(none.match(/# commands = \["<command>"\]/g)?.length, 2);
  // Uncommented, the lint example parses as a step.
  const lint = rust
    .split('\n')
    .slice(3, 6)
    .map((line) => line.replace(/^# /, ''))
    .join('\n');
  assert.deepEqual(parse(lint).steps.lint?.commands, [{ command: 'cargo', args: ['clippy', '--workspace'] }]);
});

test('course names a course pack id; left out it is null', () => {
  assert.equal(parse('').course, null);
  assert.equal(parse('course = "os"').course, 'os');
  fails('course = "OS pack"', 'course');
  fails('course = 1', 'course');
  // The template's commented example parses once uncommented.
  const line = projectConfig
    .projectTemplate('none', { lint: null, custom: null })
    .split('\n')
    .find((entry) => entry.startsWith('# course ='));
  assert.equal(parse((line as string).replace(/^# /, '')).course, 'programming');
});

test("labs lists a lab repository's labs; files without it read as before", () => {
  assert.deepEqual(parse('preset = "none"\ncourse = "os"').labs, []);
  const text = '[[labs]]\nid = "fcfs"\nstage = 1\ndir = "labs/01-fcfs/"\nconcepts = ["fcfs", "ai:queue-order", "fcfs"]\n';
  assert.deepEqual(parse(text).labs, [{ id: 'fcfs', stage: 1, dir: 'labs/01-fcfs', concepts: ['fcfs', 'ai:queue-order'] }]);
  assert.deepEqual(parse('[[labs]]\nid = "fcfs"\nstage = 1\ndir = "labs/01-fcfs"').labs[0].concepts, []);
  fails('labs = "fcfs"', 'labs');
  fails('[[labs]]\nid = "FCFS"\nstage = 1\ndir = "labs/x"', 'labs[0].id');
  fails('[[labs]]\nid = "fcfs"\nstage = 0\ndir = "labs/x"', 'labs[0].stage');
  fails('[[labs]]\nid = "fcfs"\nstage = 1\ndir = "../x"', 'labs[0].dir');
  fails('[[labs]]\nid = "fcfs"\nstage = 1\ndir = "labs/x"\nconcepts = ["Bad Id"]', 'labs[0].concepts');
  fails('[[labs]]\nid = "fcfs"\nstage = 1\ndir = "labs/x"\nhidden = "x"', 'labs[0].hidden');
  fails('[[labs]]\nid = "a"\nstage = 1\ndir = "labs/a"\n[[labs]]\nid = "a"\nstage = 2\ndir = "labs/b"', 'labs[1].id');
  fails('[[labs]]\nid = "a"\nstage = 1\ndir = "labs/a"\n[[labs]]\nid = "b"\nstage = 1\ndir = "labs/b"', 'labs[1].stage');
  // The template's commented example parses once uncommented.
  const template = projectConfig.projectTemplate('none', { lint: null, custom: null }).split('\n');
  const example = template.slice(template.indexOf('# [[labs]]'), template.indexOf('# [[labs]]') + 5).map((line) => line.replace(/^# /, ''));
  assert.deepEqual(parse(example.join('\n')).labs, [{ id: 'round-robin', stage: 1, dir: 'labs/01-round-robin', concepts: ['round-robin'] }]);
});

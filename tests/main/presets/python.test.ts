import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as checkOutput from '../../../src/main/check_output.ts';
import * as effectiveSteps from '../../../src/main/effective_steps.ts';
import * as testReport from '../../../src/main/test_report.ts';
import * as verification from '../../../src/main/verification.ts';
import * as workspace from '../../../src/main/workspace.ts';
import { detectLanguages } from '../../../src/main/presets/index.ts';
import { PYTEST_REPORT, parsePyproject, pythonPreset } from '../../../src/main/presets/python.ts';
import { env } from '../../../src/main/env.ts';
import * as requiredTools from '../../fixtures/required_tools.ts';
import type { PythonFacts } from '../../../src/main/presets/python.ts';
import type { CheckStep } from '../../../src/main/step_config.ts';

const run = promisify(execFile);
const FIXTURES = path.join(import.meta.dirname, '../fixtures');
// Real output of ruff 0.17.2 / mypy 2.4.0 / pyright 1.1.414 / pytest 9.1.1
// on the sample with an unused import and variable, a `str` returned as
// `int`, unformatted code and a failing test. Absolute paths were rewritten
// to /work/python_sample; host and times were blanked.
const ROOT = '/work/python_sample';
const sample = (name: string) => fs.readFile(path.join(FIXTURES, 'python_output', name), 'utf8');
const place = { root: ROOT, cwd: '' };
const FACTS: PythonFacts = {
  pyproject: parsePyproject('[project]\nname = "demo"\n'),
  requirements: false,
  setupPy: false,
  uvLock: true,
  uv: true,
  pyright: null,
};
const steps = pythonPreset.steps(FACTS);
const parserOf = (id: 'format' | 'lint' | 'typecheck') => (steps[id] as CheckStep).parser;
const lines = (facts: Partial<PythonFacts>) =>
  Object.fromEntries(
    Object.entries(pythonPreset.steps({ ...FACTS, ...facts })).map(([id, step]) => [
      id,
      step?.commands?.map((entry) => [entry.command, ...entry.args].join(' ')),
    ]),
  );

test('ruff check JSON becomes one error per finding, with the code as the rule', async () => {
  const content = await sample('ruff_check.json');
  const parsed = checkOutput.parseOutput(parserOf('lint'), { ...place, output: content, content });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'demo/__init__.py', line: 2, column: 8, severity: 'error', message: '`os` imported but unused', rule: 'F401' },
    { file: 'demo/__init__.py', line: 7, column: 5, severity: 'error', message: 'Local variable `unused` is assigned to but never used', rule: 'F841' },
  ]);
  assert.equal(parsed?.results.length, 2);
  // A clean run is an empty list, not unparseable.
  assert.deepEqual(checkOutput.parseOutput(parserOf('lint'), { ...place, output: '[]', content: '[]' }), { results: [], diagnostics: [] });
  // Ruff before 0.15 has no severity; its findings still fail the check.
  const old = JSON.stringify([{ filename: `${ROOT}/a.py`, location: { row: 1, column: 1 }, code: 'E501', message: 'Line too long' }]);
  assert.equal(checkOutput.parseJson(old, 'ruff', ROOT, '')?.[0]?.severity, 'error');
});

test('ruff format --check names each file it would reformat, in both output styles', async () => {
  const output = await sample('ruff_format.txt');
  const parsed = checkOutput.parseOutput(parserOf('format'), { ...place, output, content: output });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'demo/__init__.py', line: 2, column: 1, severity: 'error', message: 'File would be reformatted', rule: 'unformatted' },
  ]);
  const older = 'warning: The --output-format flag for the formatter is unstable\nWould reformat: demo/__init__.py\n1 file would be reformatted\n';
  assert.deepEqual(checkOutput.parseOutput(parserOf('format'), { ...place, output: older, content: older })?.diagnostics, [
    { file: 'demo/__init__.py', line: null, column: null, severity: 'error', message: 'Would reformat', rule: null },
  ]);
});

test('mypy JSON lines become diagnostics with 1-based columns', async () => {
  const content = await sample('mypy.jsonl');
  const parsed = checkOutput.parseOutput(parserOf('typecheck'), { ...place, output: content, content });
  assert.deepEqual(parsed?.diagnostics, [
    {
      file: 'demo/__init__.py',
      line: 12,
      column: 12,
      severity: 'error',
      message: 'Incompatible return value type (got "str", expected "int")',
      rule: 'return-value',
    },
  ]);
  // A clean run prints nothing; a crash prints no mypy line at all.
  assert.deepEqual(checkOutput.parseMypy('', ROOT, ''), []);
  assert.equal(checkOutput.parseMypy('mypy: error: Missing target module, package, files, or command.\n', ROOT, ''), null);
});

test('pyright JSON becomes diagnostics with 1-based positions', async () => {
  const content = await sample('pyright.json');
  const parsed = checkOutput.parseOutput({ format: 'json', dialect: 'pyright', path: null }, { ...place, output: content, content });
  assert.deepEqual(parsed?.diagnostics, [
    {
      file: 'demo/__init__.py',
      line: 12,
      column: 12,
      severity: 'error',
      // Pyright indents with non-breaking spaces.
      message: 'Type "Literal[\'x\']" is not assignable to return type "int"\n\u00a0\u00a0"Literal[\'x\']" is not assignable to "int"',
      rule: 'reportReturnType',
    },
  ]);
  assert.equal(checkOutput.parseJson('{"version":"1"}', 'pyright', ROOT, ''), null);
});

test("pytest's JUnit report gives each test, scoped by module", async () => {
  const results = testReport.parseJunit(await sample('pytest.xml'));
  assert.deepEqual(
    results.map((result) => [result.fullName, result.passed, result.skipped]),
    [
      ['pytest › tests.test_demo › test_adds_two_numbers', true, false],
      ['pytest › tests.test_demo › test_skipped_case', true, true],
      ['pytest › tests.test_demo › test_broken', false, false],
    ],
  );
});

test('the Python preset is recommended for pyproject.toml, requirements.txt or setup.py', () => {
  for (const manifest of ['pyproject.toml', 'requirements.txt', 'setup.py'])
    assert.deepEqual(detectLanguages(new Set([manifest])), [{ manifest, language: 'Python', preset: 'python' }]);
  assert.deepEqual(Object.keys(steps), ['setup', 'format', 'lint', 'typecheck', 'test']);
  assert.deepEqual(steps.test?.parser, { format: 'junit', path: PYTEST_REPORT });
  assert.deepEqual(steps.test?.env, { PYTHONDONTWRITEBYTECODE: '1' });
  assert.deepEqual(pythonPreset.steps({ ...FACTS, pyproject: null }), {});
  assert.deepEqual(pythonPreset.steps({ ...FACTS, pyproject: parsePyproject('[project') }), {});
  assert.deepEqual(
    pythonPreset.tools.map((tool) => tool.command),
    [process.platform === 'win32' ? 'python' : 'python3', 'uv'],
  );
});

test('with uv every tool runs through uv run --no-sync, after uv sync --locked', () => {
  assert.deepEqual(lines({}), {
    setup: ['uv sync --locked'],
    format: ['uv run --no-sync ruff format --check --output-format=concise --color never'],
    lint: ['uv run --no-sync ruff check --no-fix --output-format=json'],
    typecheck: ['uv run --no-sync mypy --output json .'],
    test: [`uv run --no-sync pytest --junitxml=${PYTEST_REPORT}`],
  });
  const devExtra = parsePyproject('[project]\nname = "d"\n[project.optional-dependencies]\ndev = ["pytest"]\n');
  assert.deepEqual(lines({ pyproject: devExtra }).setup, ['uv sync --locked --extra dev']);
  // Without a tracked uv.lock, uv sync would write one into the tree.
  assert.deepEqual(lines({ pyproject: devExtra, uvLock: false }).setup, ['uv venv --allow-existing', 'uv pip install -e .[dev]']);
  assert.deepEqual(lines({ uvLock: false, pyproject: parsePyproject('[project]\nname = "d"\n[dependency-groups]\ndev = ["pytest"]\n') }).setup, [
    'uv venv --allow-existing',
    'uv pip install -e . --group dev',
  ]);
  // Without a [project] table there is no project to install.
  assert.deepEqual(lines({ pyproject: parsePyproject('[tool.ruff]\n'), requirements: true }).setup, [
    'uv venv --allow-existing',
    'uv pip install -r requirements.txt',
  ]);
  assert.deepEqual(lines({ pyright: 'pyright' }).typecheck, ['uv run --no-sync pyright --outputjson']);
});

test('without uv the preset sets up a venv with pip and runs tools as its modules', () => {
  if (process.platform === 'win32') return;
  const pip = lines({ uv: false, pyproject: parsePyproject('[project]\nname = "d"\n[dependency-groups]\ndev = ["pytest"]\n'), requirements: true });
  assert.deepEqual(pip, {
    setup: ['python3 -m venv .venv', '.venv/bin/python -m pip install --upgrade pip', '.venv/bin/python -m pip install -e . -r requirements.txt --group dev'],
    format: ['.venv/bin/python -m ruff format --check --output-format=concise --color never'],
    lint: ['.venv/bin/python -m ruff check --no-fix --output-format=json'],
    typecheck: ['.venv/bin/python -m mypy --output json .'],
    test: [`.venv/bin/python -m pytest --junitxml=${PYTEST_REPORT}`],
  });
  assert.deepEqual(lines({ uv: false, pyproject: null, setupPy: true }).setup, ['python3 -m venv .venv', '.venv/bin/python -m pip install -e .']);
  assert.deepEqual(lines({ uv: false, pyright: 'pyright' }).typecheck, ['pyright --outputjson --pythonpath .venv/bin/python']);
});

test('suggestions offer each command for uv and for pip, one command per line', () => {
  const suggestions = pythonPreset.suggestions(FACTS);
  assert.ok(suggestions.setup?.includes('uv sync --locked'));
  assert.ok(suggestions.setup?.includes('python3 -m venv .venv'));
  assert.ok(suggestions.typecheck?.includes('uv run --no-sync pyright --outputjson'));
  assert.ok(suggestions.typecheck?.includes('uv run --no-sync mypy --output json .'));
  assert.ok(Object.values(suggestions).every((list) => list.every((line) => !line.includes('&&'))));
});

test('parsePyproject() reads the project table, a dev extra or group, and broken TOML', () => {
  assert.deepEqual(parsePyproject('[project]\nname = "demo"\n'), { valid: true, project: true, devExtra: false, devGroup: false });
  assert.deepEqual(parsePyproject('[dependency-groups]\ndev = ["pytest"]\n'), { valid: true, project: false, devExtra: false, devGroup: true });
  assert.deepEqual(parsePyproject('[project\n'), { valid: false, project: false, devExtra: false, devGroup: false });
});

// End to end on tests/main/fixtures/python_sample, through TaskPilot's own
// runner, once with uv and once with venv + pip. Needs uv and python3 on
// PATH and fetches pytest, mypy and ruff from PyPI.
const fixtureRepo = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-python-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(FIXTURES, 'python_sample'), root, { recursive: true, filter: (source) => !/[\\/](\.venv|__pycache__|\.taskpilot)$/.test(source) });
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "python"\n');
  const g = (args: string[]) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return root;
};

const hasUv = await requiredTools.hasTools('uv');
const hasPython = await requiredTools.hasTools('python3');
// The same PATH without any directory holding uv, for the venv + pip fallback.
const withoutUv = env.path
  .split(path.delimiter)
  .filter((dir) => !existsSync(path.join(dir, 'uv')))
  .join(path.delimiter);

const runAll = async (envPath: string, setup: string) => {
  const root = await fixtureRepo();
  const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: {} }), { envPath });
  assert.deepEqual(resolution.project, { status: 'ok', preset: 'python' });
  const runnable = effectiveSteps.runnable(resolution);
  assert.deepEqual(
    runnable.map((step) => step.id),
    ['setup', 'format', 'lint', 'typecheck', 'test'],
  );
  assert.equal(runnable[0].commands[0].command, setup);
  for (const step of runnable) {
    const result = await verification.runStep(root, step, { envPath });
    const line = step.commands.map((entry) => [entry.command, ...entry.args].join(' ')).join(' && ');
    assert.equal(result.exitCode, 0, `${line}: ${result.output.slice(-2000)}`);
    assert.equal(result.report.trusted, true, line);
    assert.deepEqual(result.diagnostics, [], line);
    if (step.id === 'test')
      assert.deepEqual(
        result.results.map((entry) => [entry.fullName, entry.passed, entry.skipped]),
        [
          ['pytest › tests.test_demo › test_adds_two_numbers', true, false],
          ['pytest › tests.test_demo › test_skipped_case', true, true],
        ],
        line,
      );
  }
  // Checks leave nothing behind but the ignored .venv and report.
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  assert.equal(stdout, '');
  // An unformatted file is one diagnostic through the real runner, whose
  // FORCE_COLOR=0 would otherwise turn Ruff's colour on.
  await fs.appendFile(path.join(root, 'demo/__init__.py'), 'x=1\n');
  const format = await verification.runStep(root, runnable[1], { envPath });
  assert.deepEqual(
    format.diagnostics.map((item) => [item.file, item.severity]),
    [['demo/__init__.py', 'error']],
    format.output,
  );
};

test.skipIf(!hasUv)('every Python preset step runs green on the sample with uv', () => runAll(env.path, 'uv'), 300_000);

test.skipIf(!hasPython || process.platform === 'win32')(
  'every Python preset step runs green on the sample with venv + pip',
  () => runAll(withoutUv, 'python3'),
  600_000,
);

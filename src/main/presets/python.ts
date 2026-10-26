// The Python preset: a project-local .venv set up with uv, or with venv +
// pip when uv is not on the command PATH, then Ruff, Pyright or mypy and
// pytest run inside it. Diagnostics come from Ruff's and the type checker's
// JSON and pytest's JUnit report.
//
// SECURITY: every command is a fixed argument array. Setup installs the
// project and its declared dependencies, which may run build backends, as
// any `pip install` the developer runs would; nothing is installed until
// the user runs the setup step. uv itself is only detected, never installed.
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import * as git from '../git.ts';
import { indexEntries, readTracked } from '../repo_reader.ts';
import { semverOrNull } from '../semver.ts';
import { resolveExecutable } from '../workspace.ts';
import { formatCommandLine } from '../command_line.ts';
import type { Preset } from './preset.ts';
import type { StepId, StepKind } from '../../shared/check_steps.ts';
import type { StepPatch } from '../step_config.ts';
import type { LooseJson } from '../loose_json.ts';
import type { CommandEntry } from '../command_line.ts';

// The parts of pyproject.toml the preset reads: whether it declares a
// project (installable, and what `uv sync` needs), and a `dev` extra or
// dependency group to install with it.
export type PyProject = { valid: boolean; project: boolean; devExtra: boolean; devGroup: boolean };

// Which manifests and lockfile are tracked, whether uv is on the command
// PATH, and the Pyright command when Pyright is on that PATH or in .venv.
export type PythonFacts = {
  pyproject: PyProject | null;
  requirements: boolean;
  setupPy: boolean;
  uvLock: boolean;
  uv: boolean;
  pyright: string | null;
};

const WINDOWS = process.platform === 'win32';
const PYTHON = WINDOWS ? 'python' : 'python3';
const VENV_BIN = WINDOWS ? '.venv/Scripts' : '.venv/bin';
const VENV_PYTHON = `${VENV_BIN}/python${WINDOWS ? '.exe' : ''}`;

export const parsePyproject = (content: string): PyProject => {
  let raw: LooseJson;
  try {
    raw = parseToml(content);
  } catch {
    return { valid: false, project: false, devExtra: false, devGroup: false };
  }
  const project = raw.project && typeof raw.project === 'object' ? raw.project : null;
  return {
    valid: true,
    project: Boolean(project),
    devExtra: Array.isArray(project?.['optional-dependencies']?.dev),
    devGroup: Array.isArray(raw['dependency-groups']?.dev),
  };
};

// pyproject.toml's `[project].version`, else Poetry's
// `[tool.poetry].version`; null when neither is semver (a `dynamic`
// version is only known after a build).
const pyprojectVersion = (content: string | null) => {
  if (content === null) return null;
  let raw: LooseJson;
  try {
    raw = parseToml(content);
  } catch {
    return null;
  }
  return semverOrNull(raw.project?.version) ?? semverOrNull(raw.tool?.poetry?.version);
};

// Installing dependencies can take a while on a cold cache.
const SLOW_MS = 15 * 60 * 1000;

const command = (name: string, ...args: string[]): CommandEntry => ({ command: name, args });

// A tool inside the environment: `uv run` finds .venv (and falls back to
// the PATH); without uv it is the venv's Python module. --no-sync keeps a
// check from changing the environment it checks.
const tool = (uv: boolean, name: string, ...args: string[]) =>
  uv ? command('uv', 'run', '--no-sync', name, ...args) : command(VENV_PYTHON, '-m', name, ...args);

// What `pip install` / `uv pip install` gets: the project itself with its
// dev extra, and requirements.txt.
const installArgs = ({ pyproject, requirements, setupPy }: PythonFacts) => {
  const args: string[] = [];
  if (pyproject?.project || setupPy) args.push('-e', pyproject?.devExtra ? '.[dev]' : '.');
  if (requirements) args.push('-r', 'requirements.txt');
  return args;
};

const setupCommands = (facts: PythonFacts): CommandEntry[] => {
  const install = installArgs(facts);
  const group = facts.pyproject?.project && facts.pyproject.devGroup ? ['--group', 'dev'] : [];
  if (facts.uv) {
    // `uv sync` would write a uv.lock into the tree under review, so only
    // a tracked lockfile is synced, and never changed.
    if (facts.pyproject?.project && facts.uvLock) return [command('uv', 'sync', '--locked', ...(facts.pyproject.devExtra ? ['--extra', 'dev'] : []))];
    return [command('uv', 'venv', '--allow-existing'), ...(install.length || group.length ? [command('uv', 'pip', 'install', ...install, ...group)] : [])];
  }
  // pip learned --group in 25.1, newer than the pip venv bundles.
  return [
    command(PYTHON, '-m', 'venv', '.venv'),
    ...(group.length ? [command(VENV_PYTHON, '-m', 'pip', 'install', '--upgrade', 'pip')] : []),
    ...(install.length || group.length ? [command(VENV_PYTHON, '-m', 'pip', 'install', ...install, ...group)] : []),
  ];
};

// `ruff format --check --output-format=concise` prints
// `<file>:<line>:<col>: unformatted: <message>`; Ruff before 0.15 ignores
// the flag outside preview and prints `Would reformat: <file>`. Ruff takes
// any FORCE_COLOR, even the runner's `0`, as a request for colour, which
// would put escape codes inside the line; --color never keeps it plain.
const RUFF_FORMAT = '^(?:(?<file>[^:\\s][^:]*):(?<line>\\d+):(?<column>\\d+): (?<rule>[\\w-]+): (?<message>.+)|(?<message>Would reformat): (?<file>.+))$';

// pytest writes its JUnit report here; .taskpilot/ is never part of a package.
export const PYTEST_REPORT = '.taskpilot/reports/pytest.xml';

const typecheck = (facts: PythonFacts): StepPatch => {
  if (!facts.pyright) return { commands: [tool(facts.uv, 'mypy', '--output', 'json', '.')], parser: { format: 'json', dialect: 'mypy', path: null } };
  // Without uv, Pyright is pointed at the venv; `uv run` activates it.
  const pyright = facts.uv ? tool(true, 'pyright', '--outputjson') : command(facts.pyright, '--outputjson', '--pythonpath', VENV_PYTHON);
  return { commands: [pyright], parser: { format: 'json', dialect: 'pyright', path: null } };
};

const defaultSteps = (facts: PythonFacts): Partial<Record<StepId, StepPatch>> => ({
  setup: { commands: setupCommands(facts), parser: { format: 'exitcode' }, timeoutMs: SLOW_MS },
  format: {
    commands: [tool(facts.uv, 'ruff', 'format', '--check', '--output-format=concise', '--color', 'never')],
    parser: { format: 'regex', pattern: RUFF_FORMAT, severity: 'error' },
  },
  // --no-fix: a project's `fix = true` must not edit files under review.
  lint: { commands: [tool(facts.uv, 'ruff', 'check', '--no-fix', '--output-format=json')], parser: { format: 'json', dialect: 'ruff', path: null } },
  typecheck: typecheck(facts),
  // Bytecode would leave untracked __pycache__ directories in the tree.
  // `uv run pytest` is the venv's pytest, `python -m pytest` without uv.
  test: {
    commands: [tool(facts.uv, 'pytest', `--junitxml=${PYTEST_REPORT}`)],
    parser: { format: 'junit', path: PYTEST_REPORT },
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  },
});

export const pythonPreset: Preset<PythonFacts> = {
  id: 'python',
  label: 'Python',
  manifests: ['pyproject.toml', 'requirements.txt', 'setup.py'],
  detect: (tracked) => ['pyproject.toml', 'requirements.txt', 'setup.py'].some((manifest) => tracked.has(manifest)),
  facts: async (root, { envPath } = {}) => {
    const tracked = await indexEntries(root);
    const { files } = await readTracked(root, ['pyproject.toml'], { maxFiles: 1, maxFileBytes: 64 * 1024, maxTotalBytes: 64 * 1024 });
    const lookup = { cwd: root, ...(envPath ? { envPath } : {}) };
    const onPath = (name: string) => resolveExecutable(name, lookup).then(Boolean);
    const venvPyright = `${VENV_BIN}/pyright${WINDOWS ? '.exe' : ''}`;
    const pyright = (await onPath('pyright')) ? 'pyright' : (await onPath(venvPyright)) ? venvPyright : null;
    return {
      pyproject: files[0] ? parsePyproject(files[0].content) : null,
      requirements: tracked.has('requirements.txt'),
      setupPy: tracked.has('setup.py'),
      uvLock: tracked.has('uv.lock'),
      uv: await onPath('uv'),
      pyright,
    };
  },
  steps: (facts) => {
    if (facts.pyproject ? !facts.pyproject.valid : !facts.requirements && !facts.setupPy) return {};
    return defaultSteps(facts);
  },
  // Each command as uv and as venv + pip would run it, and both type
  // checkers; one line per command, as settings take them.
  suggestions: (facts) => {
    const suggestions: Partial<Record<StepKind, string[]>> = {};
    const modes = [true, false].flatMap((uv) => [facts.pyright ?? 'pyright', null].map((pyright) => ({ ...facts, uv, pyright })));
    for (const mode of modes)
      for (const [kind, step] of Object.entries(defaultSteps(mode)) as [StepKind, StepPatch][]) {
        suggestions[kind] = [...new Set([...(suggestions[kind] ?? []), ...(step.commands ?? []).map(formatCommandLine)])];
      }
    suggestions.coverage = ['uv run --no-sync pytest --cov', `${VENV_PYTHON} -m pytest --cov`];
    return suggestions;
  },
  tools: [
    { command: PYTHON, versionArgs: ['--version'], install: 'brew install python   # 或从 https://www.python.org/downloads/ 安装' },
    { command: 'uv', versionArgs: ['--version'], install: 'curl -LsSf https://astral.sh/uv/install.sh | sh   # 可选；没有 uv 时用 venv + pip' },
  ],
  // [人工决策-2026-10-25 23:51:35] Python 仓库的项目配置、依赖清单和 pytest 配置改动要人工确认（CARM-16 #9）。
  // 这会让更多补丁停下等确认，与 work_package_status.ts 的全自动闭环决策不冲突：有确认项本来就停下等人。
  protectedFiles: [
    /(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|conftest\.py|tox\.ini|noxfile\.py|uv\.lock)$/i,
    // requirements*.txt, and the files of a requirements/ folder.
    /(?:^|\/)requirements(?:[^/]*|\/[^/]+)\.txt$/i,
  ],
  secretFiles: [/(?:^|\/)\.pypirc$/i],
  sandboxEnv: (agentHome) => ({ PIP_CACHE_DIR: path.join(agentHome, '.cache', 'pip'), UV_CACHE_DIR: path.join(agentHome, '.cache', 'uv') }),
  sandboxRead: () => [],
  version: async (root, commit) => ({ file: 'pyproject.toml', value: pyprojectVersion(await git.showFile(root, commit, 'pyproject.toml')) }),
};

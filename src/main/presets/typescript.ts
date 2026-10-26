// The TypeScript / JavaScript preset: npm scripts from package.json, read
// the way TaskPilot always has. Environment setup for it (install, rebuild)
// lives in ./typescript_setup.ts.
//
// A repository without taskpilot.toml gets no preset steps, so it behaves
// exactly as before: only the steps set in settings run.
import * as git from '../git.ts';
import { readTracked } from '../repo_reader.ts';
import { semverOrNull } from '../semver.ts';
import { SCRIPT_NAME, parseManifest, typescriptSetup } from './typescript_setup.ts';
import type { Manifest } from './typescript_setup.ts';
import type { Preset } from './preset.ts';
import type { SetupAdapter } from '../setup_adapter.ts';
import type { StepId, StepKind } from '../../shared/check_steps.ts';
import type { StepPatch } from '../step_config.ts';

export type TypeScriptFacts = { manifest: Manifest | null };

// Script names each step looks for, best first.
const SCRIPTS: Partial<Record<StepKind, string[]>> = {
  build: ['build'],
  format: ['format:check', 'fmt:check', 'prettier:check'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'check:types'],
  test: ['test'],
  coverage: ['coverage', 'test:coverage'],
};

// `npm test` for the test script, `npm run <name>` for the rest.
export const scriptLine = (name: string) => (name === 'test' ? 'npm test' : `npm run ${name}`);

const npm = (name: string) => (name === 'test' ? { command: 'npm', args: ['test'] } : { command: 'npm', args: ['run', '--silent', name] });

// Parsers for what the npm script typically wraps: tsc's
// `file(line,col): error TSxxxx: message` lines, and every other step by
// its tests or exit code. ESLint's own format is not assumed, since the
// script's flags are the project's.
// package.json's `version`, or null.
const packageVersion = (content: string | null) => {
  if (content === null) return null;
  try {
    return semverOrNull((JSON.parse(content) as { version?: unknown } | null)?.version);
  } catch {
    return null;
  }
};

const TSC_LINE = '^(?<file>[^\\s(][^(]*)\\((?<line>\\d+),(?<column>\\d+)\\): (?<severity>error|warning) (?<rule>TS\\d+): (?<message>.+)$';

// vitest writes its JUnit report here; .taskpilot/ is never part of a package.
export const VITEST_REPORT = '.taskpilot/reports/vitest.xml';

// [人工决策-2026-10-26 13:15:53] vitest 仓库读 JUnit 报告判定测试结果，与 pytest 一致（CARM-22 方案 1）。
// A test script that is vitest alone: `vitest`, `vitest run` or `npx vitest`,
// then flags only. `npm test -- <args>` appends to the end of the script, so
// a chained script (`a && vitest run`) could hand them to another command;
// a subcommand or positional (`vitest bench`, `vitest src`), an env prefix
// or the script's own reporter, output file or watch flag keeps the default
// step, whose results come from the output.
const VITEST_ALONE = /^(?:npx )?vitest(?: run)?(?: --?[\w-]+(?:=[\w./:@-]+)?)*$/;
const VITEST_OWN_FLAGS = /(?:^| )--?(?:reporter|outputFile|watch|w)(?:[=. ]|$)/;

export const runsVitestAlone = (script: string) => {
  const line = script.trim().replace(/\s+/g, ' ');
  return VITEST_ALONE.test(line) && !VITEST_OWN_FLAGS.test(line);
};

const testStep = (script: string): StepPatch =>
  runsVitestAlone(script)
    ? {
        commands: [{ command: 'npm', args: ['test', '--', '--reporter=default', '--reporter=junit', `--outputFile=${VITEST_REPORT}`] }],
        parser: { format: 'junit', path: VITEST_REPORT },
      }
    : { commands: [npm('test')], parser: { format: 'tests' } };

export const typescriptPreset: Preset<TypeScriptFacts> = {
  id: 'typescript',
  label: 'TypeScript / JavaScript',
  manifests: ['package.json'],
  testLayout: '*.test.ts or *.spec.ts files in tests/, in __tests__/ or next to the code',
  detect: (tracked) => tracked.has('package.json'),
  facts: async (root) => {
    const { files } = await readTracked(root, ['package.json'], { maxFiles: 1, maxFileBytes: 64 * 1024, maxTotalBytes: 64 * 1024 });
    return { manifest: files[0] ? parseManifest(files[0].content) : null };
  },
  steps: ({ manifest }) => {
    const scripts = manifest?.scripts ?? {};
    const steps: Partial<Record<StepId, StepPatch>> = {};
    for (const [kind, names] of Object.entries(SCRIPTS) as [StepKind, string[]][]) {
      const name = names.find((candidate) => Object.hasOwn(scripts, candidate) && SCRIPT_NAME.test(candidate));
      if (!name) continue;
      if (kind === 'test') {
        steps.test = testStep(scripts[name]);
        continue;
      }
      const parser = kind === 'typecheck' ? { format: 'regex' as const, pattern: TSC_LINE, severity: 'error' as const } : { format: 'exitcode' as const };
      steps[kind] = { commands: [npm(name)], parser };
    }
    if (Object.hasOwn(scripts, 'build') || Object.hasOwn(scripts, 'test'))
      steps.setup = { commands: [{ command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] }], parser: { format: 'exitcode' } };
    return steps;
  },
  suggestions: ({ manifest }) => {
    const names = Object.keys(manifest?.scripts ?? {}).filter((name) => SCRIPT_NAME.test(name));
    const suggestions: Partial<Record<StepKind, string[]>> = {
      setup: ['npm ci --ignore-scripts --no-audit --no-fund', 'npm install --ignore-scripts --no-audit --no-fund'],
    };
    for (const [kind, preferred] of Object.entries(SCRIPTS) as [StepKind, string[]][]) {
      const matching = names.filter((name) => preferred.includes(name) || name.startsWith(`${kind}:`));
      suggestions[kind] = matching.map(scriptLine);
    }
    suggestions.typecheck = [...(suggestions.typecheck ?? []), 'npx tsc --noEmit'];
    suggestions.lint = [...(suggestions.lint ?? []), 'npx eslint .'];
    suggestions.format = [...(suggestions.format ?? []), 'npx prettier --check .'];
    return suggestions;
  },
  tools: [
    { command: 'node', versionArgs: ['--version'], install: 'brew install node   # 或从 https://nodejs.org 安装' },
    { command: 'npm', versionArgs: ['--version'], install: 'npm 随 Node.js 一起安装' },
  ],
  // vitest's JUnit report names a test by its describe() blocks and title.
  testNameFormat:
    'the enclosing describe() names and the test\'s own title joined with " > " (vitest), e.g. "auth > login > locks after five failures"; a test outside any describe() is just its title, e.g. "exports login"',
  // The npm files and cache are in the fixed rules and sandbox environment,
  // so every repository keeps them.
  protectedFiles: [],
  secretFiles: [],
  sandboxEnv: () => ({}),
  sandboxRead: () => [],
  version: async (root, commit) => ({ file: 'package.json', value: packageVersion(await git.showFile(root, commit, 'package.json')) }),
  setup: typescriptSetup as SetupAdapter,
};

// The TypeScript / JavaScript preset: npm scripts from package.json, read
// the way TaskPilot always has. Environment setup for it (install, rebuild)
// lives in ./typescript_setup.ts.
//
// A repository without taskpilot.toml gets no preset steps, so it behaves
// exactly as before: only the steps set in settings run.
import { readTracked } from '../repo_reader.ts';
import { SCRIPT_NAME, parseManifest } from './typescript_setup.ts';
import type { Manifest } from './typescript_setup.ts';
import type { Preset } from './preset.ts';
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
const TSC_LINE = '^(?<file>[^\\s(][^(]*)\\((?<line>\\d+),(?<column>\\d+)\\): (?<severity>error|warning) (?<rule>TS\\d+): (?<message>.+)$';

export const typescriptPreset: Preset<TypeScriptFacts> = {
  id: 'typescript',
  label: 'TypeScript / JavaScript',
  manifests: ['package.json'],
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
      const parser =
        kind === 'test'
          ? { format: 'tests' as const }
          : kind === 'typecheck'
            ? { format: 'regex' as const, pattern: TSC_LINE, severity: 'error' as const }
            : { format: 'exitcode' as const };
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
  // The npm files and cache are in the fixed rules and sandbox environment,
  // so every repository keeps them.
  protectedFiles: [],
  secretFiles: [],
  sandboxEnv: () => ({}),
  sandboxRead: () => [],
};

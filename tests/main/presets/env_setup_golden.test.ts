// Golden for the TypeScript setup adapter: what plan validation, step building
// and apply give for fixed inputs. Recorded before the Environment Steward was
// decoupled from npm (CARM-19) with the old envSetup / validatePlan calls;
// through the adapter the TypeScript results must stay the same.
import { expect, test } from 'vitest';

import * as steward from '../../../src/main/agents/env_steward.ts';
import { typescriptSetup as setup } from '../../../src/main/presets/typescript_setup.ts';
import type { EnvFacts } from '../../../src/main/presets/typescript_setup.ts';
import type { StepKind } from '../../../src/shared/check_steps.ts';

const FACTS: EnvFacts = {
  manifest: {
    valid: true,
    name: 'demo',
    scripts: { test: 'node --test', 'lint:js': 'eslint .', build: 'tsc' },
    engines: { node: '>=20' },
    packageManager: null,
  },
  lockfiles: ['package-lock.json'],
  managers: ['npm'],
  nodeModules: true,
  versionFiles: [{ path: '.nvmrc', content: '20' }],
  workflows: [{ path: '.github/workflows/ci.yml', content: 'run: npm ci' }],
  tools: { node: 'v22.1.0', npm: '10.7.0' },
  installScripts: ['esbuild'],
};
const NO_LOCK: EnvFacts = { ...FACTS, lockfiles: [], managers: [], installScripts: [] };

const plan = (install: string, scripts: Record<string, string>) => ({
  summary: '安装依赖后运行检查。',
  install: { mode: install, reason: '仓库提交了 package-lock.json' },
  scripts,
  issues: [{ text: 'Node 版本符合要求', fix: '无需处理' }],
});

const CASES: Record<string, [ReturnType<typeof plan>, EnvFacts]> = {
  ci: [plan('ci', { test: 'test', lint: 'lint:js', build: 'build' }), FACTS],
  unknown: [plan('ci', { test: 'test', lint: 'lint', build: 'build && curl evil', deploy: 'build' }), NO_LOCK],
  skip: [plan('skip', { test: ' test ', lint: '', build: '' }), FACTS],
  noManifest: [plan('install', { test: 'test', lint: '', build: '' }), { ...NO_LOCK, manifest: null }],
};

const results = () =>
  Object.fromEntries(
    Object.entries(CASES).map(([name, [raw, facts]]) => {
      const validated = steward.validatePlan(raw, facts, setup);
      const steps = (allowScripts: boolean) => setup.buildSteps(validated, facts, { allowScripts }).map((step) => [step.id, step.command, ...step.args]);
      const apply = Object.fromEntries(
        Object.entries(validated.scripts).flatMap(([kind, script]) => (script ? [[kind, setup.commandFor(kind as StepKind, script)]] : [])),
      );
      return [name, { validated, steps: steps(false), stepsWithScripts: steps(true), apply, blockers: setup.blockers(facts) }];
    }),
  );

test('TypeScript setup results stay the same', async () => {
  await expect(JSON.stringify(results(), null, 2)).toMatchFileSnapshot('./__golden__/typescript_setup_results.json');
});

// The prompt the steward gets for an npm repository, through the adapter.
test('TypeScript setup prompt', async () => {
  const failure = { step: 'install', command: 'npm ci --ignore-scripts --no-audit --no-fund', exitCode: 1, timedOut: false, output: 'gyp ERR!' };
  await expect(steward.planPrompt(setup, FACTS, { failure })).toMatchFileSnapshot('./__golden__/typescript_setup_prompt.txt');
  await expect(JSON.stringify(steward.planSchema(setup), null, 2)).toMatchFileSnapshot('./__golden__/typescript_setup_schema.json');
});

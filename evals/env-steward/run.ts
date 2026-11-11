#!/usr/bin/env node
// Real model calls; deliberately outside the normal test commands.
import { planEnvironment } from '../../src/main/agents/pipeline.ts';
import { typescriptSetup } from '../../src/main/checking/presets/typescript_setup.ts';
import { fixtureRepo, judgeWith, runAgent, runSuite } from '../shared/harness.ts';
import { cases } from './cases.ts';
import type { EnvironmentCase } from './cases.ts';

const CRITERIA = {
  fit: 'The plan fits the actual framework and existing tooling. It preserves working scripts and avoids unnecessary migrations, a web build for native-only apps, and arbitrary coverage thresholds.',
  completeness:
    'Missing infrastructure becomes a focused work package with concrete steps, exact files and verifiable acceptance, including repository check wiring. Machine-only issues stay diagnostics.',
  execution:
    'The proposal is clear enough for Coding Agent to implement, covers required dependencies/configuration/lockfiles, and can pass the normal review flow. It never claims that proposed scripts already exist or that anything has been installed.',
};

const runCase = async (testCase: EnvironmentCase, { judge }: { judge: boolean }) => {
  const repo = await fixtureRepo(testCase.id, testCase.files);
  const started = Date.now();
  try {
    const result = await planEnvironment({ root: repo.root, setup: typescriptSetup, runAgent });
    const plan = result.plan;
    const proposal = plan?.configuration;
    const proposedKinds = new Set(proposal?.checks.map((check) => check.kind) ?? []);
    const checks = {
      proposal: { pass: Boolean(proposal) === testCase.configurationExpected, detail: 'Propose configuration when infrastructure is missing, otherwise null.' },
      required_checks: {
        pass: testCase.requiredChecks.every((kind) => proposedKinds.has(kind)),
        detail: testCase.requiredChecks.join(', ') || 'No missing checks expected.',
      },
      not_runnable_yet: {
        pass:
          !proposal ||
          proposal.checks.every((check) => !plan?.scripts[check.kind] || Object.hasOwn(result.facts?.manifest?.scripts ?? {}, plan.scripts[check.kind]!)),
        detail: 'A proposed script must not become runnable before it exists.',
      },
    };
    const judged = judge
      ? await judgeWith(
          CRITERIA,
          'Review the Environment Steward plan against the repository facts. Score each criterion from 1 to 5 and name concrete flaws.',
          JSON.stringify({ files: testCase.files, plan }, null, 2),
        )
      : null;
    return {
      id: testCase.id,
      seconds: Math.round((Date.now() - started) / 1000),
      agentCostUsd: result.costUsd,
      judgeCostUsd: judged?.costUsd ?? 0,
      run: plan,
      checks,
      scores: judged?.scores ?? null,
    };
  } finally {
    await repo.cleanup();
  }
};

runSuite({ suiteDir: import.meta.dirname, cases, criteria: Object.keys(CRITERIA) as (keyof typeof CRITERIA)[], runCase }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

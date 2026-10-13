// Deterministic checks on one Architect run.
import type { CheckResult } from '../shared/harness.ts';
import type { AdjudicationCase, SummaryCase } from './cases.ts';
import type { AdjudicationResult, InterfaceSummary } from '../../src/main/agents/architect.ts';

// The selection includes the files a useful summary needs, and the summary
// mentions facts only the code shows.
export const checkSummary = (
  testCase: Pick<SummaryCase, 'expect'>,
  run: { read: string[]; summary: InterfaceSummary | null; text: string | null },
): Record<string, CheckResult> => {
  const read = new Set(run.read);
  const missing = testCase.expect.mustRead.filter((file) => !read.has(file));
  const text = run.text ?? '';
  const found = testCase.expect.grounding.filter((term) => text.includes(term));
  const needed = Math.ceil((testCase.expect.grounding.length * 2) / 3);
  return {
    summarized: { pass: run.summary !== null && run.summary.modules.length > 0, detail: run.summary ? `${run.summary.modules.length} modules` : 'no summary' },
    selection: { pass: missing.length === 0, detail: missing.length ? `did not read ${missing.join(', ')}` : `read ${run.read.length} files` },
    codeGrounding: { pass: found.length >= needed, detail: `${found.length}/${testCase.expect.grounding.length} terms: ${found.join(', ') || 'none'}` },
    // Every module path was read; validateSummary enforces it, so a failure here is a harness bug.
    onlyReadModules: {
      pass: (run.summary?.modules ?? []).every((module) => read.has(module.path)),
      detail: 'module paths come from read files',
    },
  };
};

export const checkAdjudication = (testCase: Pick<AdjudicationCase, 'expect'>, result: AdjudicationResult): Record<string, CheckResult> => {
  const checks: Record<string, CheckResult> = {
    decision: { pass: result.decision === testCase.expect.decision, detail: `expected ${testCase.expect.decision}, got ${result.decision}: ${result.reason}` },
  };
  if (testCase.expect.scopeIncludes?.length) {
    const scope = new Set(result.revision?.fileScope ?? []);
    const missing = testCase.expect.scopeIncludes.filter((file) => !scope.has(file));
    checks.revisedScope = { pass: missing.length === 0, detail: missing.length ? `scope lacks ${missing.join(', ')}` : 'scope covers the fix' };
  }
  return checks;
};

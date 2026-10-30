import { onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { draftPath as draftPathValue, verifyPath as verifyPathValue } from '../../../src/main/courses/lab_artifact.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as goals from '../../fixtures/course_interview.ts';
import {
  HIDDEN_MARKER as hiddenMarker,
  RR_CODE as roundRobinCode,
  RR_SPEC as roundRobinSpec,
  SOLUTION_MARKER as solutionMarker,
} from '../../fixtures/lab_generator.ts';
import { RR_MUTANT_EDITS as roundRobinMutantEdits, graded as gradedValue } from '../../fixtures/lab_verify.ts';
import type { RunStructuredOptions } from '../../../src/main/runtimes/claude_cli.ts';
import type { Grader as GraderType } from '../../../src/main/courses/lab_verify.ts';

export const draftPath = draftPathValue;
export const verifyPath = verifyPathValue;
export const HIDDEN_MARKER = hiddenMarker;
export const RR_CODE = roundRobinCode;
export const RR_SPEC = roundRobinSpec;
export const SOLUTION_MARKER = solutionMarker;
export const RR_MUTANT_EDITS = roundRobinMutantEdits;
export type Grader = GraderType;
export type Schema = Record<string, unknown>;
export const graded = gradedValue;
export type Step = 'interview' | 'path' | 'spec' | 'code' | 'mutants' | 'consistency' | 'repair';
const LAB_PARTS = ['readme', 'build', 'publicTests', 'hiddenTests', 'starter', 'solution', 'hints'];
const schemaKeys = (schema: Schema) => (Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
export const stepOf = (schema: Schema): Step => {
  const keys = schemaKeys(schema);
  if (keys.includes('mutants')) return 'mutants';
  if (keys.includes('issues')) return 'consistency';
  if (keys.includes('id') && keys.includes('hiddenTests')) return 'spec';
  if (keys.includes('starter') && keys.includes('solution') && keys.includes('hints') && keys.length === 3) return 'code';
  if (keys.some((key) => LAB_PARTS.includes(key))) return 'repair';
  const properties = schema.properties;
  return properties && typeof properties === 'object' && 'course' in properties ? 'interview' : 'path';
};

export const passingGrader: Grader = async (files) => {
  const names = Object.entries(files)
    .filter(([file]) => file.startsWith('tests/public/'))
    .flatMap(([, script]) => [...script.matchAll(/^check "([^"]+)"/gm)].map((match) => match[1]));
  const solved = files['src/rr.c'] === RR_CODE.solution[0].content;
  return graded(Object.fromEntries(names.map((name) => [name, solved])));
};

const MUTANTS = { mutants: RR_MUTANT_EDITS };

export const RR_PATH = {
  ...goals.SCHEDULING_PATH,
  path: goals.SCHEDULING_PATH.path.map((entry) => ({ ...entry, status: entry.conceptId === 'round-robin' ? 'planned' : 'known' })),
};

export const team =
  ({
    spec = RR_SPEC,
    code = RR_CODE,
    gate = null,
    issues = [],
    repair = {},
    path: coursePath = RR_PATH,
  }: { spec?: unknown; code?: unknown; gate?: Promise<void> | null; issues?: unknown[][]; repair?: unknown; path?: unknown } = {}) =>
  async ({ schema, signal }: Pick<RunStructuredOptions, 'schema'> & Partial<Pick<RunStructuredOptions, 'signal'>>) => {
    const step = stepOf(schema);
    if (step === 'code' && gate) await gate;
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'agent_cancelled' });
    const output =
      step === 'consistency'
        ? { issues: issues.shift() ?? [] }
        : { interview: goals.SCHEDULING_CLARIFY, path: coursePath, spec, code, mutants: MUTANTS, repair }[step];
    const costUsd = { spec: 0.4, code: 0.4, mutants: 0.1, consistency: 0.05, repair: 0.3 }[step] ?? 0.01;
    return { output, costUsd };
  };

export const harness = (options: Parameters<typeof fixtures.harness>[0] = {}) => fixtures.harness({ labGrader: passingGrader, ...options });

export const confirmedCourse = async (h) => {
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: goals.GOAL_FORM });
  await h.idle();
  await h.call(CHANNELS.requirementsPlan, data.id, [''], { course: 'os' });
  await h.idle();
  assert.equal((await h.call(CHANNELS.requirementsPublish, data.id)).data.status, 'published');
  return data.id as string;
};

export const settleLab = async (h, id: string) => {
  await h.idle();
  return (await h.call(CHANNELS.requirementsGet, id)).data;
};

export const labFolder = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-place-')));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-home-'));
  await fs.writeFile(path.join(home, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  return dir;
};

export const finishedReview = (passed: number) => ({
  status: passed === 3 ? 'passed' : 'rejected',
  error: null,
  startedAt: '2026-10-27T00:00:00Z',
  finishedAt: '2026-10-27T00:01:00Z',
  reasons: [],
  attention: [],
  checks: [
    {
      kind: 'test',
      stage: 'submit',
      blocking: true,
      baseline: 'measured',
      status: passed === 3 ? 'pass' : 'fail',
      reason: null,
      newFailures: [],
      preexisting: [],
      fixed: [],
      run: {
        kind: 'test',
        command: 'make grade',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        summary: { total: 3, passed, failed: 3 - passed, skipped: 0, ok: passed === 3 },
        report: null,
        failing: [],
        outputTail: null,
      },
    },
  ],
  verification: null,
  acceptance: [],
  report: null,
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0,
});

export const gradeOnce = (
  h,
  conceptId: string,
  passed: number,
  { difficulty = 'easy', hintLevel = null, digest }: { difficulty?: string; hintLevel?: number | null; digest: string },
) =>
  h.mastery.record({
    mode: 'practice',
    course: 'os',
    concepts: [conceptId],
    packageId: `lab-${conceptId}`,
    repoId: 'repo1',
    diffDigest: digest,
    review: finishedReview(passed),
    report: { comments: [], errorTags: [] },
    difficulty,
    hintLevel,
    at: new Date(Date.UTC(2026, 9, 27, 1) + Number(digest.slice(1)) * 60_000).toISOString(),
  });

export const ORDER_TEST = {
  file: '01_rr_order.sh',
  names: ['作业运行中到达时的入队顺序'],
  script: `#!/bin/sh\ncheck "作业运行中到达时的入队顺序" "$(printf '2\\n' | build/rr)" "$(printf '2\\n' | build/rr)"\n`,
};

export const exampleGrader: Grader = async (files, options) => {
  const result = await passingGrader(files, options);
  const orderMutant = files['src/rr.c'] === RR_CODE.solution[0].content.replace(RR_MUTANT_EDITS[0].edits[0].find, () => RR_MUTANT_EDITS[0].edits[0].replace);
  if (!orderMutant || `tests/public/${ORDER_TEST.file}` in files) return result;
  return graded(Object.fromEntries(Object.keys(result.results).map((name) => [name, true])));
};

export const PRIORITY_SPEC = {
  ...RR_SPEC,
  id: 'priority-sched',
  title: '优先级调度',
  acceptance: [{ text: '高优先级先运行', test: '高优先级的作业先运行' }],
  program: 'prio',
  entry: 'src/prio.c',
  starterFiles: ['src/prio.c'],
  fileScope: ['src/prio.c'],
  publicTests: [{ file: '02_prio.sh', names: ['高优先级的作业先运行'], script: '#!/bin/sh\nbuild/prio </dev/null\necho "ok - 高优先级的作业先运行"\n' }],
  hiddenTests: [{ file: '02_prio_hidden.sh', names: ['同优先级按到达先后'], script: '#!/bin/sh\nbuild/prio </dev/null\necho "ok - 同优先级按到达先后"\n' }],
};
export const PRIORITY_CODE = { ...RR_CODE, starter: [{ path: 'src/prio.c', content: '// TODO\n' }], solution: [{ path: 'src/prio.c', content: '// done\n' }] };
export const PRIORITY_MUTANTS = {
  mutants: ['反了', '漏了', '错了', '少了', '多了'].map((word) => ({ description: word, edits: [{ path: 'src/prio.c', find: 'done', replace: word }] })),
};

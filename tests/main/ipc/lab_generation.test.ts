// Generating a course's first lab after its path is confirmed
// (src/main/lab_generation_service.ts): the estimate comes first and runs no
// model; generating writes a private draft the renderer never sees, checks
// it (src/main/lab_verify.ts, with a faked `make grade` here) and the draft
// becomes a lab artifact with a reference patch made by git.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as labs from '../../../src/main/labs.ts';
import { draftPath, verifyPath } from '../../../src/main/lab_generation_service.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as goals from '../../fixtures/course_interview.ts';
import { HIDDEN_MARKER, RR_CODE, RR_SPEC, SOLUTION_MARKER } from '../../fixtures/lab_generator.ts';
import { RR_MUTANT_EDITS, graded } from '../../fixtures/lab_verify.ts';
import type { Grader } from '../../../src/main/lab_verify.ts';

vi.setConfig({ testTimeout: 20_000 });

type Step = 'interview' | 'path' | 'spec' | 'code' | 'mutants' | 'consistency' | 'repair';
const LAB_PARTS = ['readme', 'build', 'publicTests', 'hiddenTests', 'starter', 'solution', 'hints'];
const stepOf = (schema): Step => {
  const keys: string[] = schema.required ?? [];
  if (keys.includes('mutants')) return 'mutants';
  if (keys.includes('issues')) return 'consistency';
  if (keys.includes('id') && keys.includes('hiddenTests')) return 'spec';
  if (keys.includes('starter') && keys.includes('solution') && keys.includes('hints') && keys.length === 3) return 'code';
  // A repair's schema holds only the parts it rewrites.
  if (keys.some((key) => LAB_PARTS.includes(key))) return 'repair';
  return schema.properties.course ? 'interview' : 'path';
};

// `make grade` as the self-check would see it for this lab: the solution
// passes every test it is given, the starter and every mutant fail them.
const passingGrader: Grader = async (files) => {
  const names = Object.entries(files)
    .filter(([file]) => file.startsWith('tests/public/'))
    .flatMap(([, script]) => [...script.matchAll(/^check "([^"]+)"/gm)].map((match) => match[1]));
  const solved = files['src/rr.c'] === RR_CODE.solution[0].content;
  return graded(Object.fromEntries(names.map((name) => [name, solved])));
};

const MUTANTS = { mutants: RR_MUTANT_EDITS };

// The scheduling path starts with sched-metrics once process-state is known;
// this one starts at round-robin, as in the example.
const RR_PATH = {
  ...goals.SCHEDULING_PATH,
  path: goals.SCHEDULING_PATH.path.map((entry) => ({ ...entry, status: entry.conceptId === 'round-robin' ? 'planned' : 'known' })),
};

// A fake Tutor for the interview and the generator's two calls. `gate` holds
// the code call until it resolves, for cancelling mid-run.
// `issues` are the review's answers, one per round (empty when it runs out).
const team =
  ({
    spec = RR_SPEC,
    code = RR_CODE,
    gate = null,
    issues = [],
    repair = {},
    path = RR_PATH,
  }: { spec?: unknown; code?: unknown; gate?: Promise<void> | null; issues?: unknown[][]; repair?: unknown; path?: unknown } = {}) =>
  async ({ schema, signal }: { schema: any; signal?: AbortSignal }) => {
    const step = stepOf(schema);
    if (step === 'code' && gate) await gate;
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'agent_cancelled' });
    const output =
      step === 'consistency' ? { issues: issues.shift() ?? [] } : { interview: goals.SCHEDULING_CLARIFY, path, spec, code, mutants: MUTANTS, repair }[step];
    const costUsd = { spec: 0.4, code: 0.4, mutants: 0.1, consistency: 0.05, repair: 0.3 }[step] ?? 0.01;
    return { output, costUsd };
  };

const harness = (options: Parameters<typeof fixtures.harness>[0] = {}) => fixtures.harness({ labGrader: passingGrader, ...options });

// A confirmed course path, ready for its first lab.
const confirmedCourse = async (h) => {
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: goals.GOAL_FORM });
  await fixtures.settle(h.call, data.id);
  await h.call(CHANNELS.requirementsPlan, data.id, [''], { course: 'os' });
  await fixtures.settle(h.call, data.id);
  assert.equal((await h.call(CHANNELS.requirementsPublish, data.id)).data.status, 'published');
  return data.id as string;
};

const settleLab = async (call, id: string): Promise<any> => {
  for (let index = 0; index < 500; index += 1) {
    const item = (await call(CHANNELS.requirementsGet, id)).data;
    if (item.course.lab && item.course.lab.status !== 'running') return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the lab never settled');
};

test('the estimate names the first concept to learn, counts the self-check in and runs no model', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  const calls = h.agentCalls.length;
  const { data, error } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(error, undefined);
  assert.deepEqual(data.concepts, [{ id: 'round-robin', label: '时间片轮转（RR）' }]);
  assert.equal(data.difficulty, 'easy', 'a learner who knows the basics starts easy');
  assert.equal(data.calls, 4, 'two to generate, mutants and the review once');
  assert.equal(data.maxCalls, 10, 'three rounds of two reviews and two repairs');
  assert.ok(data.tokens.input > 10_000 && data.tokens.output >= 300_000, JSON.stringify(data.tokens));
  assert.equal(data.usd, null, 'no price table has been synced');
  assert.equal(h.agentCalls.length, calls);
});

test('the estimate prices the tokens with the synced price table', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  const prefs = fixtures.validPrefs();
  const saved = await h.call(CHANNELS.preferencesSet, {
    ...prefs,
    agents: { ...prefs.agents, tutor: { cli: 'claude', model: 'claude-opus-5-5', thinking: 'default' } },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  const table = { syncedAt: '2026-10-27T00:00:00Z', exact: { anthropic: { 'claude-opus-5-5': [5, 25, 0.5, 6.25] } }, firstParty: {} };
  await fs.writeFile(path.join(h.configDir, 'model_prices.json'), JSON.stringify(table));
  const { data } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(data.model, 'claude-opus-5-5');
  // The lab-gen eval spent $2.3 to $3.9 a lab on this model to generate; the
  // self-check adds one round at the low end, a repair and a second round at the high.
  assert.ok(data.usd.low > 2.5 && data.usd.low < 4 && data.usd.high > 7 && data.usd.high < 13, JSON.stringify(data.usd));
});

test('a lab is only generated for a confirmed course path', async () => {
  const h = await harness({ agent: team() });
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: goals.GOAL_FORM });
  await fixtures.settle(h.call, data.id);
  assert.equal((await h.call(CHANNELS.requirementsLabEstimate, data.id)).error.code, 'invalid_state');
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, data.id)).error.code, 'invalid_state');
  const project = (await h.call(CHANNELS.requirementsCreate, { text: '邮箱登录' })).data;
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, project.id)).error.code, 'invalid_state');
});

test('generating writes a private draft and checks it; the renderer sees only the title, counts and verdicts', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  const started = (await h.call(CHANNELS.requirementsLabGenerate, id)).data;
  assert.equal(started.course.lab.status, 'running');
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).error.code, 'invalid_state', 'one run at a time');
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'ready', JSON.stringify(item.course.lab.error));
  assert.deepEqual(item.course.lab.lab, {
    id: 'round-robin',
    title: '时间片轮转调度',
    summary: '用就绪队列按时间片轮流运行作业。',
    estimateHours: 2,
    starterFiles: 1,
    publicTests: 2,
    hiddenTests: 1,
  });
  // Generating (0.8) and one self-check round: mutants (0.1) and the review (0.05).
  assert.ok(Math.abs(item.course.lab.costUsd - 0.95) < 1e-9, String(item.course.lab.costUsd));
  assert.ok(item.costUsd >= 0.95, 'the requirement adds the spend');
  assert.deepEqual(item.course.lab.verify, {
    round: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        checks: { reference: true, starter: true, mutants: true, consistency: true },
        mutants: { killed: 5, publicKilled: 5, total: 5 },
        issues: 0,
        repaired: false,
      },
    ],
    costUsd: item.course.lab.verify.costUsd,
  });
  assert.ok(Math.abs(item.course.lab.verify.costUsd - 0.15) < 1e-9);
  // The prompts carried the pack's labGuide and the confirmed path's goal.
  const specCall = h.agentCalls.find((call) => stepOf(call.schema) === 'spec')!;
  assert.match(specCall.prompt, /user-space C simulator/);
  assert.match(specCall.prompt, /- round-robin: /);
  // Nothing private reaches a channel the renderer reads.
  const visible = JSON.stringify([await h.call(CHANNELS.requirementsList), await h.call(CHANNELS.requirementsGet, id), await h.call(CHANNELS.listTasks)]);
  for (const marker of [
    SOLUTION_MARKER,
    HIDDEN_MARKER,
    '一个用完时间片时',
    'enqueue(arrived)',
    RR_MUTANT_EDITS[0].description,
    ...RR_SPEC.hiddenTests[0].names,
  ])
    assert.ok(!visible.includes(marker), marker);
  // The draft is kept outside any repository, readable by this user only.
  const file = draftPath(h.configDir, id);
  assert.ok(!file.startsWith(h.root));
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.ok((await fs.readFile(file, 'utf8')).includes(SOLUTION_MARKER));
  // So is the self-check's report, with what each check found.
  const verify = JSON.parse(await fs.readFile(verifyPath(h.configDir, id), 'utf8'));
  assert.equal((await fs.stat(verifyPath(h.configDir, id))).mode & 0o077, 0);
  assert.equal(verify.status, 'passed');
  assert.deepEqual(
    verify.rounds[0].mutantResults.map((result) => result.description),
    RR_MUTANT_EDITS.map((entry) => entry.description),
  );
  // Every call's spend is on the cost page, under Tutor and the requirement.
  const report = (await h.call(CHANNELS.costsReport, 7)).data;
  const row = report.bySubject.find((entry) => entry.kind === 'requirement' && entry.id === id);
  assert.ok(row, JSON.stringify(report.bySubject));
  assert.equal(row.calls, 4 + 2, 'the interview and the path, generation, mutants and the review');
});

test('the draft becomes a lab artifact with a git-made reference patch that applies to the starter', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h.call, id);
  const artifact = await h.labGeneration.artifact(id);
  assert.deepEqual(artifact.concepts, ['round-robin']);
  assert.deepEqual(artifact.difficulty, { level: 'easy', reason: RR_SPEC.difficultyReason });
  assert.deepEqual(Object.keys(artifact.publicTests), ['01_rr.sh']);
  assert.deepEqual(Object.keys(artifact.private.hidden), ['01_rr_hidden.sh']);
  assert.deepEqual(artifact.private.rubric, RR_SPEC.rubricNotes);
  assert.match(artifact.private.reference, /^diff --git a\/src\/rr\.c b\/src\/rr\.c\n/);
  // Applied to the starter, the patch gives the solution.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-apply-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/rr.c'), artifact.files['src/rr.c']);
    await fs.writeFile(path.join(root, 'ref.patch'), artifact.private.reference);
    await fixtures.run('git', ['init', '-q'], { cwd: root });
    await fixtures.run('git', ['apply', 'ref.patch'], { cwd: root });
    assert.equal(await fs.readFile(path.join(root, 'src/rr.c'), 'utf8'), RR_CODE.solution[0].content);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(labs.checkLab(artifact, 1), artifact, 'it passes the lab checks as it is');
});

test('a lab that does not validate fails the run with its error, keeping what it cost', async () => {
  const leaking = { ...RR_SPEC, hiddenTests: [{ ...RR_SPEC.hiddenTests[0], names: ['输出 b=3'], script: 'echo "ok - 输出 b=3"' }] };
  const h = await harness({ agent: team({ spec: leaking }) });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_bad_output');
  assert.match(item.course.lab.error.message, /must not give away/);
  assert.equal(item.course.lab.costUsd, 0.4);
  assert.equal((await h.labGeneration.artifact(id).catch((error) => error)).code, 'no_lab_draft');
});

test('cancelling stops the run before the code call lands, and a retry starts over', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harness({ agent: team({ gate }) });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  for (let index = 0; index < 200 && (await h.call(CHANNELS.requirementsGet, id)).data.course.lab.phase !== 'code'; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await h.call(CHANNELS.repositoriesBusy)).data[0].kind, 'requirement', 'a switch asks before cancelling it');
  assert.equal((await h.call(CHANNELS.requirementsCancel, id)).data, true);
  release();
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_cancelled');
  await h.call(CHANNELS.requirementsLabGenerate, id);
  assert.equal((await settleLab(h.call, id)).course.lab.status, 'ready');
});

test('repair() rewrites the named parts of the draft and keeps the new version', async () => {
  const hiddenTests = [{ file: '01_rr_more.sh', names: ['空闲之后到达的作业'], script: 'echo "ok - 空闲之后到达的作业"\n' }];
  const base = team();
  const h = await harness({
    agent: async (options) => {
      const schema = options.schema as { required: string[]; properties: Record<string, unknown> };
      return schema.required.length === 1 && schema.properties.hiddenTests ? { output: { hiddenTests }, costUsd: 0.1 } : base(options);
    },
  });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h.call, id);
  const { draft, costUsd } = await h.labGeneration.repair(id, { report: 'a mutant survived', parts: ['hiddenTests'] });
  assert.equal(costUsd, 0.1);
  assert.deepEqual(draft.lab.hiddenTests, hiddenTests);
  assert.deepEqual(Object.keys((await h.labGeneration.artifact(id)).private.hidden), ['01_rr_more.sh']);
  assert.match(h.agentCalls.at(-1)!.prompt, /<report>\na mutant survived\n<\/report>/);
});

test('a lab interrupted by a quit is failed on the next load', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h.call, id);
  const file = path.join(h.repoDir, 'requirements.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.find((item) => item.id === id).course.lab.status = 'running';
  await fs.writeFile(file, JSON.stringify(saved));
  await h.requirements.open(h.repoDir);
  const lab: any = h.requirements.get(id).course!.lab;
  assert.equal(lab.status, 'failed');
  assert.equal(lab.error.code, 'agent_interrupted');
});

// ========== Self-check ==========

// The CARM-33 example's second round: the repair added the hidden test the
// surviving mutant needed, and the review is satisfied.
const ORDER_TEST = { file: '01_rr_order.sh', names: ['作业运行中到达时的入队顺序'], script: `#!/bin/sh\ncheck "作业运行中到达时的入队顺序" "x" "x"\n` };
// The first round's grader: the queue-order mutant passes every test until
// the repaired lab carries ORDER_TEST.
const exampleGrader: Grader = async (files, options) => {
  const result = await passingGrader(files, options);
  const orderMutant = files['src/rr.c'] === RR_CODE.solution[0].content.replace(RR_MUTANT_EDITS[0].edits[0].find, () => RR_MUTANT_EDITS[0].edits[0].replace);
  if (!orderMutant || `tests/public/${ORDER_TEST.file}` in files) return result;
  return graded(Object.fromEntries(Object.keys(result.results).map((name) => [name, true])));
};

test('the example’s retry path: round 1 misses a mutant and finds an issue, the repair fixes both, round 2 passes', async () => {
  const issue = { kind: 'untested_requirement', detail: '题面没有说清作业运行时新到的作业和被抢占的作业谁先入队' };
  const h = await harness({
    agent: team({ issues: [[issue], []], repair: { publicTests: RR_SPEC.publicTests, hiddenTests: [...RR_SPEC.hiddenTests, ORDER_TEST] } }),
    labGrader: exampleGrader,
  });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'ready', JSON.stringify(item.course.lab.error));
  const rounds = item.course.lab.verify.rounds;
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[0], {
    round: 1,
    checks: { reference: true, starter: true, mutants: true, consistency: false },
    mutants: { killed: 4, publicKilled: 4, total: 5 },
    issues: 1,
    repaired: true,
  });
  assert.deepEqual(rounds[1].checks, { reference: true, starter: true, mutants: true, consistency: true });
  assert.equal(rounds[1].mutants.killed, 5);
  assert.equal(item.course.lab.lab.hiddenTests, 2, 'the learner sees the repaired lab’s counts');
  // The repair was told what failed, in the checks' own words, and asked only for the parts involved.
  const repairCall = h.agentCalls.find((call) => stepOf(call.schema) === 'repair')!;
  assert.match(repairCall.prompt, /Not caught: 被抢占的作业排在新到作业之前入队/);
  assert.match(repairCall.prompt, /untested_requirement: 题面没有说清/);
  assert.deepEqual([...(repairCall.schema.required as string[])].sort(), ['hiddenTests', 'publicTests']);
  // 0.8 generating, two rounds of 0.15, one repair of 0.3; all on the requirement and the cost page.
  assert.ok(Math.abs(item.course.lab.costUsd - 1.4) < 1e-9, String(item.course.lab.costUsd));
  const row = (await h.call(CHANNELS.costsReport, 7)).data.bySubject.find((entry) => entry.kind === 'requirement' && entry.id === id);
  assert.equal(row.calls, 2 + 2 + 2 * 2 + 1);
  // The repaired draft and its report become the lab's private parts.
  const artifact = await h.labGeneration.artifact(id);
  assert.deepEqual(Object.keys(artifact.private.hidden), ['01_rr_hidden.sh', '01_rr_order.sh']);
  const verify = artifact.private.verify as { status: string; rounds: { mutantResults: { killed: boolean; description: string }[] }[] };
  assert.equal(verify.status, 'passed');
  assert.deepEqual(
    verify.rounds[0].mutantResults.filter((result) => !result.killed).map((result) => result.description),
    ['被抢占的作业排在新到作业之前入队'],
  );
});

test('a lab still failing after two repairs needs review, and another concept on the path can be generated instead', async () => {
  const issue = { kind: 'outside_interface', detail: '参考解用了题面没给的 qsort' };
  // Two concepts still to learn: round-robin, then priority-sched.
  const path = { ...RR_PATH, path: RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)) };
  const h = await harness({ agent: team({ issues: [[issue], [issue], [issue]], repair: { solution: RR_CODE.solution }, path }) });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'needs_review');
  assert.equal(item.course.lab.verify.rounds.length, 3);
  assert.deepEqual(
    item.course.lab.verify.rounds.map((round) => round.repaired),
    [true, true, false],
  );
  const repairs = h.agentCalls.filter((call) => stepOf(call.schema) === 'repair');
  assert.equal(repairs.length, 2, 'two retries, never a third');
  assert.deepEqual(repairs[0].schema.required, ['solution'], 'an interface outside the statement is the solution’s to fix');
  assert.ok(Math.abs(item.course.lab.costUsd - (0.8 + 3 * 0.15 + 2 * 0.3)) < 1e-9, String(item.course.lab.costUsd));
  // 换一个知识点: only a concept still to learn on the path.
  assert.equal((await h.call(CHANNELS.requirementsLabEstimate, id, 'fcfs')).error.code, 'invalid_argument');
  const estimated = await h.call(CHANNELS.requirementsLabEstimate, id, 'priority-sched');
  assert.equal(estimated.error, undefined, JSON.stringify(estimated.error));
  const estimate = estimated.data;
  assert.deepEqual(
    estimate.concepts.map((entry) => entry.id),
    ['priority-sched'],
  );
  await h.call(CHANNELS.requirementsLabGenerate, id, 'priority-sched');
  assert.deepEqual((await settleLab(h.call, id)).course.lab.concepts, ['priority-sched']);
  const specCall = h.agentCalls.filter((call) => stepOf(call.schema) === 'spec').at(-1)!;
  assert.match(specCall.prompt, /- priority-sched: /);
});

test('cancelling during the self-check stops it and keeps what was spent', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: Grader = async (files, options) => {
    await gate;
    return passingGrader(files, options);
  };
  const h = await harness({ agent: team(), labGrader: gated });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  for (let index = 0; index < 200 && (await h.call(CHANNELS.requirementsGet, id)).data.course.lab.phase !== 'verify'; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const running = (await h.call(CHANNELS.requirementsGet, id)).data.course.lab;
  assert.equal(running.phase, 'verify');
  assert.deepEqual(running.verify, { round: 1, maxRounds: 3, rounds: [], costUsd: 0 });
  assert.equal((await h.call(CHANNELS.requirementsCancel, id)).data, true);
  release();
  const item = await settleLab(h.call, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_cancelled');
  assert.equal(item.course.lab.costUsd, 0.8, 'the generation was spent');
});

// ========== Next lab (src/main/lab_progress.ts) ==========

// A finished review with `passed` of 3 tests passing.
const finishedReview = (passed: number) => ({
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

const gradeOnce = (
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

test('the CARM-33 example: after round-robin first passes with L3, the next lab is priority-sched at the same difficulty', async () => {
  const path = { ...RR_PATH, path: RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)) };
  const h = await harness({ agent: team({ path }) });
  const id = await confirmedCourse(h);
  assert.deepEqual(
    (await h.call(CHANNELS.requirementsLabEstimate, id)).data.concepts.map((entry) => entry.id),
    ['round-robin'],
  );
  // Rejected on a hidden test first, then 8/8 with L1 and L3 opened.
  await gradeOnce(h, 'round-robin', 2, { hintLevel: 3, digest: 'd1' });
  await gradeOnce(h, 'round-robin', 3, { hintLevel: 3, digest: 'd2' });
  const { data, error } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(error, undefined, JSON.stringify(error));
  assert.deepEqual(
    data.concepts.map((entry) => entry.id),
    ['priority-sched'],
  );
  assert.equal(data.difficulty, 'easy');
  assert.equal(data.change, 'kept');
  assert.equal(data.stuck, null);
});

test('a concept failing at easy twice is stuck: the estimate lists its notes, and skipping it moves the path on', async () => {
  const path = { ...RR_PATH, path: RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)) };
  const h = await harness({ agent: team({ path }) });
  const id = await confirmedCourse(h);
  await h.notes.create({
    title: 'RR 入队顺序',
    body: '先入队新到的作业。',
    category: 'mechanism',
    course: 'os',
    concepts: ['round-robin'],
    tags: [],
    source: null,
  });
  await h.notes.create({ title: '别的笔记', body: '无关。', category: null, tags: [], source: null });
  await gradeOnce(h, 'round-robin', 0, { digest: 'd1' });
  let estimate = (await h.call(CHANNELS.requirementsLabEstimate, id)).data;
  assert.deepEqual([estimate.concepts[0].id, estimate.difficulty, estimate.stuck], ['round-robin', 'easy', null]);
  await gradeOnce(h, 'round-robin', 1, { digest: 'd2' });
  estimate = (await h.call(CHANNELS.requirementsLabEstimate, id)).data;
  assert.equal(estimate.concepts[0].id, 'round-robin');
  assert.deepEqual(estimate.stuck, { notes: [{ id: 'RR 入队顺序.md', title: 'RR 入队顺序' }] });
  // Skipping is refused for a concept that is not still to learn.
  assert.equal((await h.call(CHANNELS.requirementsCourseSkip, id, 'fcfs')).error.code, 'invalid_argument');
  const skipped = await h.call(CHANNELS.requirementsCourseSkip, id, 'round-robin');
  assert.equal(skipped.error, undefined, JSON.stringify(skipped.error));
  assert.equal(skipped.data.course.plan.path.find((entry) => entry.conceptId === 'round-robin').status, 'skipped');
  estimate = (await h.call(CHANNELS.requirementsLabEstimate, id)).data;
  assert.deepEqual(
    estimate.concepts.map((entry) => entry.id),
    ['priority-sched'],
  );
});

test('two fails at medium lower the next lab to easy', async () => {
  const h = await harness({ agent: team() });
  const id = await confirmedCourse(h);
  await gradeOnce(h, 'round-robin', 0, { difficulty: 'medium', digest: 'd1' });
  await gradeOnce(h, 'round-robin', 0, { difficulty: 'medium', digest: 'd2' });
  const estimate = (await h.call(CHANNELS.requirementsLabEstimate, id)).data;
  assert.deepEqual([estimate.difficulty, estimate.change, estimate.stuck], ['easy', 'lowered', null]);
});

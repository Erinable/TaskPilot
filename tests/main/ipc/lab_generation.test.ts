// Generating a course's first lab after its path is confirmed
// (src/main/lab_generation_service.ts): the estimate comes first and runs no
// model; generating writes a private draft the renderer never sees, and the
// draft becomes a lab artifact with a reference patch made by git.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as labs from '../../../src/main/labs.ts';
import { draftPath } from '../../../src/main/lab_generation_service.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as goals from '../../fixtures/course_interview.ts';
import { HIDDEN_MARKER, RR_CODE, RR_SPEC, SOLUTION_MARKER } from '../../fixtures/lab_generator.ts';

vi.setConfig({ testTimeout: 20_000 });

type Step = 'interview' | 'path' | 'spec' | 'code';
const stepOf = (schema): Step =>
  schema.properties.hiddenTests ? 'spec' : schema.properties.starter ? 'code' : schema.properties.course ? 'interview' : 'path';

// The scheduling path starts with sched-metrics once process-state is known;
// this one starts at round-robin, as in the example.
const RR_PATH = {
  ...goals.SCHEDULING_PATH,
  path: goals.SCHEDULING_PATH.path.map((entry) => ({ ...entry, status: entry.conceptId === 'round-robin' ? 'planned' : 'known' })),
};

// A fake Tutor for the interview and the generator's two calls. `gate` holds
// the code call until it resolves, for cancelling mid-run.
const team =
  ({ spec = RR_SPEC, code = RR_CODE, gate = null }: { spec?: unknown; code?: unknown; gate?: Promise<void> | null } = {}) =>
  async ({ schema, signal }: { schema: any; signal?: AbortSignal }) => {
    const step = stepOf(schema);
    if (step === 'code' && gate) await gate;
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'agent_cancelled' });
    const output = { interview: goals.SCHEDULING_CLARIFY, path: RR_PATH, spec, code }[step];
    return { output, costUsd: step === 'spec' || step === 'code' ? 0.4 : 0.01 };
  };

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

test('the estimate names the first concept to learn and runs no model', async () => {
  const h = await fixtures.harness({ agent: team() });
  const id = await confirmedCourse(h);
  const calls = h.agentCalls.length;
  const { data, error } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(error, undefined);
  assert.deepEqual(data.concepts, [{ id: 'round-robin', label: '时间片轮转（RR）' }]);
  assert.equal(data.difficulty, 'easy', 'a learner who knows the basics starts easy');
  assert.equal(data.calls, 2);
  assert.ok(data.tokens.input > 10_000 && data.tokens.output >= 200_000, JSON.stringify(data.tokens));
  assert.equal(data.usd, null, 'no price table has been synced');
  assert.equal(h.agentCalls.length, calls);
});

test('the estimate prices the tokens with the synced price table', async () => {
  const h = await fixtures.harness({ agent: team() });
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
  // The lab-gen eval spent $2.3 to $3.9 a lab on this model.
  assert.ok(data.usd.low > 2 && data.usd.high > data.usd.low && data.usd.high < 7, JSON.stringify(data.usd));
});

test('a lab is only generated for a confirmed course path', async () => {
  const h = await fixtures.harness({ agent: team() });
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: goals.GOAL_FORM });
  await fixtures.settle(h.call, data.id);
  assert.equal((await h.call(CHANNELS.requirementsLabEstimate, data.id)).error.code, 'invalid_state');
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, data.id)).error.code, 'invalid_state');
  const project = (await h.call(CHANNELS.requirementsCreate, { text: '邮箱登录' })).data;
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, project.id)).error.code, 'invalid_state');
});

test('generating writes a private draft; the renderer sees only the title and counts', async () => {
  const h = await fixtures.harness({ agent: team() });
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
  assert.equal(item.course.lab.costUsd, 0.8);
  assert.ok(item.costUsd >= 0.8, 'the requirement adds the spend');
  // The prompts carried the pack's labGuide and the confirmed path's goal.
  const specCall = h.agentCalls.find((call) => stepOf(call.schema) === 'spec')!;
  assert.match(specCall.prompt, /user-space C simulator/);
  assert.match(specCall.prompt, /- round-robin: /);
  // Nothing private reaches a channel the renderer reads.
  const visible = JSON.stringify([await h.call(CHANNELS.requirementsList), await h.call(CHANNELS.requirementsGet, id), await h.call(CHANNELS.listTasks)]);
  for (const marker of [SOLUTION_MARKER, HIDDEN_MARKER, '一个用完时间片时', 'enqueue(arrived)']) assert.ok(!visible.includes(marker), marker);
  // The draft is kept outside any repository, readable by this user only.
  const file = draftPath(h.configDir, id);
  assert.ok(!file.startsWith(h.root));
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.ok((await fs.readFile(file, 'utf8')).includes(SOLUTION_MARKER));
  // The spend is on the cost page, under Tutor and the requirement.
  const report = (await h.call(CHANNELS.costsReport, 7)).data;
  assert.ok(report.bySubject.some((row) => row.kind === 'requirement' && row.id === id));
});

test('the draft becomes a lab artifact with a git-made reference patch that applies to the starter', async () => {
  const h = await fixtures.harness({ agent: team() });
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
  const h = await fixtures.harness({ agent: team({ spec: leaking }) });
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
  const h = await fixtures.harness({ agent: team({ gate }) });
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
  const h = await fixtures.harness({
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
  const h = await fixtures.harness({ agent: team() });
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

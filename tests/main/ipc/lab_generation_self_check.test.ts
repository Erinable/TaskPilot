import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fixtures from './harness.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as lab from './lab_generation_fixtures.ts';

const settleLab = lab.settleLab;

test('repair() rewrites the named parts of the draft and keeps the new version', async () => {
  const hiddenTests = [{ file: '01_rr_more.sh', names: ['空闲之后到达的作业'], script: 'echo "ok - 空闲之后到达的作业"\n' }];
  const base = lab.team();
  const h = await lab.harness({
    agent: async (options) => {
      const schema = options.schema;
      const required = Array.isArray(schema.required) ? schema.required : [];
      return required.length === 1 && schema.properties && typeof schema.properties === 'object' && 'hiddenTests' in schema.properties
        ? { output: { hiddenTests }, costUsd: 0.1 }
        : base(options);
    },
  });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h, id);
  const { draft, costUsd } = await h.labGeneration.repair(id, { report: 'a mutant survived', parts: ['hiddenTests'] });
  assert.equal(costUsd, 0.1);
  assert.deepEqual(draft.lab.hiddenTests, hiddenTests);
  assert.deepEqual(Object.keys((await h.labGeneration.artifact(id)).private.hidden), ['01_rr_more.sh']);
  assert.match(h.agentCalls.at(-1)!.prompt, /<report>\na mutant survived\n<\/report>/);
});

const issue = { kind: 'untested_requirement', detail: '题面没有说清作业运行时新到的作业和被抢占的作业谁先入队' };

test('the retry path repairs the lab after a missed mutant and review issue', async () => {
  const h = await lab.harness({
    agent: lab.team({ issues: [[issue], []], repair: { publicTests: lab.RR_SPEC.publicTests, hiddenTests: [...lab.RR_SPEC.hiddenTests, lab.ORDER_TEST] } }),
    labGrader: lab.exampleGrader,
  });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h, id);
  assert.equal(item.course.lab.status, 'ready', JSON.stringify(item.course.lab.error));
  const rounds = item.course.lab.verify.rounds;
  assert.deepEqual(
    rounds.map((round) => [round.mutants.killed, round.issues, round.repaired]),
    [
      [4, 1, true],
      [5, 0, false],
    ],
  );
  assert.equal(item.course.lab.lab.hiddenTests, 2);
  const repairCall = h.agentCalls.find((call) => lab.stepOf(call.schema) === 'repair')!;
  assert.match(repairCall.prompt, /Not caught: 被抢占的作业排在新到作业之前入队/);
  assert.match(repairCall.prompt, /untested_requirement: 题面没有说清/);
  assert.deepEqual([...(repairCall.schema.required as string[])].sort(), ['hiddenTests', 'publicTests']);
  assert.ok(Math.abs(item.course.lab.costUsd - 1.4) < 1e-9);
  const artifact = await h.labGeneration.artifact(id);
  assert.deepEqual(Object.keys(artifact.private.hidden), ['01_rr_hidden.sh', '01_rr_order.sh']);
});

test('a lab still failing after two repairs needs review, and another concept can be generated instead', async () => {
  const failing = { kind: 'outside_interface', detail: '参考解用了题面没给的 qsort' };
  const path = { ...lab.RR_PATH, path: lab.RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)) };
  const h = await lab.harness({ agent: lab.team({ issues: [[failing], [failing], [failing]], repair: { solution: lab.RR_CODE.solution }, path }) });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h, id);
  assert.equal(item.course.lab.status, 'needs_review');
  assert.equal(item.course.lab.verify.rounds.length, 3);
  assert.deepEqual(
    item.course.lab.verify.rounds.map((round) => round.repaired),
    [true, true, false],
  );
  const repairs = h.agentCalls.filter((call) => lab.stepOf(call.schema) === 'repair');
  assert.equal(repairs.length, 2);
  assert.deepEqual(repairs[0].schema.required, ['solution']);
  assert.ok(Math.abs(item.course.lab.costUsd - (0.8 + 3 * 0.15 + 2 * 0.3)) < 1e-9);
  assert.equal((await h.call(CHANNELS.requirementsLabEstimate, id, 'fcfs')).error.code, 'invalid_argument');
  const estimated = await h.call(CHANNELS.requirementsLabEstimate, id, 'priority-sched');
  assert.equal(estimated.error, undefined, JSON.stringify(estimated.error));
  assert.deepEqual(
    estimated.data.concepts.map((entry) => entry.id),
    ['priority-sched'],
  );
  await h.call(CHANNELS.requirementsLabGenerate, id, 'priority-sched');
  assert.deepEqual((await settleLab(h, id)).course.lab.concepts, ['priority-sched']);
});

test('cancelling during the self-check stops it and keeps what was spent', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const h = await lab.harness({
    agent: lab.team(),
    labGrader: async (files, options) => {
      await gate;
      return lab.passingGrader(files, options);
    },
  });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await fixtures.until(
    async () => (await h.call(CHANNELS.requirementsGet, id)).data.course.lab.phase,
    (phase) => phase === 'verify',
    'lab generation verify phase',
  );
  assert.equal((await h.call(CHANNELS.requirementsCancel, id)).data, true);
  release();
  const item = await settleLab(h, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_cancelled');
  assert.equal(item.course.lab.costUsd, 0.8);
});

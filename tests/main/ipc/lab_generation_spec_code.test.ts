/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as labs from '../../../src/main/courses/labs.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as lab from './lab_generation_fixtures.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

const settleLab = lab.settleLab;

test('generating writes a private draft and checks it; the renderer sees only the title, counts and verdicts', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await lab.confirmedCourse(h);
  const started = (await h.call(CHANNELS.requirementsLabGenerate, id)).data;
  assert.equal(started.course.lab.status, 'running');
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).error.code, 'invalid_state');
  const item = await settleLab(h, id);
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
  assert.ok(Math.abs(item.course.lab.costUsd - 0.95) < 1e-9);
  assert.ok(item.costUsd >= 0.95);
  assert.deepEqual(item.course.lab.verify.rounds[0].checks, { reference: true, starter: true, mutants: true, consistency: true });
  assert.equal(item.course.lab.verify.rounds[0].mutants.killed, 5);
  assert.equal(item.course.lab.verify.rounds[0].issues, 0);
  assert.equal(item.course.lab.verify.rounds[0].repaired, false);
  assert.ok(Math.abs(item.course.lab.verify.costUsd - 0.15) < 1e-9);
  const specCall = h.agentCalls.find((call) => lab.stepOf(call.schema) === 'spec')!;
  assert.match(specCall.prompt, /user-space C simulator/);
  assert.match(specCall.prompt, /- round-robin: /);
  const visible = JSON.stringify([await h.call(CHANNELS.requirementsList), await h.call(CHANNELS.requirementsGet, id), await h.call(CHANNELS.tasksList)]);
  for (const marker of [
    lab.SOLUTION_MARKER,
    lab.HIDDEN_MARKER,
    '一个用完时间片时',
    'enqueue(arrived)',
    lab.RR_MUTANT_EDITS[0].description,
    ...lab.RR_SPEC.hiddenTests[0].names,
  ])
    assert.ok(!visible.includes(marker), marker);
  const file = lab.draftPath(h.configDir, id);
  assert.ok(!file.startsWith(h.root));
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.ok((await fs.readFile(file, 'utf8')).includes(lab.SOLUTION_MARKER));
  const verify = JSON.parse(await fs.readFile(lab.verifyPath(h.configDir, id), 'utf8'));
  assert.equal((await fs.stat(lab.verifyPath(h.configDir, id))).mode & 0o077, 0);
  assert.equal(verify.status, 'passed');
  assert.deepEqual(
    verify.rounds[0].mutantResults.map((result) => result.description),
    lab.RR_MUTANT_EDITS.map((entry) => entry.description),
  );
  const report = (await h.call(CHANNELS.costsReport, 7)).data;
  const row = report.bySubject.find((entry) => entry.kind === 'requirement' && entry.id === id);
  assert.equal(row.calls, 6);
});

test('the draft becomes a lab artifact with a git-made reference patch that applies to the starter', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h, id);
  const artifact = await h.labGeneration.artifact(id);
  assert.deepEqual(artifact.concepts, ['round-robin']);
  assert.deepEqual(artifact.difficulty, { level: 'easy', reason: lab.RR_SPEC.difficultyReason });
  assert.deepEqual(Object.keys(artifact.publicTests), ['01_rr.sh']);
  assert.deepEqual(Object.keys(artifact.private.hidden), ['01_rr_hidden.sh']);
  assert.deepEqual(artifact.private.rubric, lab.RR_SPEC.rubricNotes);
  assert.match(artifact.private.reference, /^diff --git a\/src\/rr\.c b\/src\/rr\.c\n/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-apply-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/rr.c'), artifact.files['src/rr.c']);
    await fs.writeFile(path.join(root, 'ref.patch'), artifact.private.reference);
    await fixtures.run('git', ['init', '-q'], { cwd: root });
    await fixtures.run('git', ['apply', 'ref.patch'], { cwd: root });
    assert.equal(await fs.readFile(path.join(root, 'src/rr.c'), 'utf8'), lab.RR_CODE.solution[0].content);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(labs.checkLab(artifact, 1), artifact);
});

test('a lab that does not validate fails the run with its error, keeping what it cost', async () => {
  captureExpectedErrors(
    (error) => 'code' in error && error.code === 'agent_bad_output' && error.message.includes('hiddenTests[0].names[0]') && error.message.includes('输出 b=3'),
  );
  const leaking = { ...lab.RR_SPEC, hiddenTests: [{ ...lab.RR_SPEC.hiddenTests[0], names: ['输出 b=3'], script: 'echo "ok - 输出 b=3"' }] };
  const h = await lab.harness({ agent: lab.team({ spec: leaking }) });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const item = await settleLab(h, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_bad_output');
  assert.match(item.course.lab.error.message, /must not give away/);
  assert.equal(item.course.lab.costUsd, 0.4);
  assert.equal((await h.labGeneration.artifact(id).catch((error) => error)).code, 'no_lab_draft');
});

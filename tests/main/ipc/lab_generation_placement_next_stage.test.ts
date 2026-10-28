/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as lab from './lab_generation_fixtures.ts';

const settleLab = lab.settleLab;

const gradeOnce = lab.gradeOnce;

test('after round-robin first passes with L3, the next lab is priority-sched at the same difficulty', async () => {
  const coursePath = {
    ...lab.RR_PATH,
    path: lab.RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)),
  };
  const h = await lab.harness({ agent: lab.team({ path: coursePath }) });
  const id = await lab.confirmedCourse(h);
  assert.deepEqual(
    (await h.call(CHANNELS.requirementsLabEstimate, id)).data.concepts.map((entry) => entry.id),
    ['round-robin'],
  );
  await gradeOnce(h, 'round-robin', 2, { hintLevel: 3, digest: 'd1' });
  await gradeOnce(h, 'round-robin', 3, { hintLevel: 3, digest: 'd2' });
  const { data, error } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(error, undefined, JSON.stringify(error));
  assert.deepEqual(
    data.concepts.map((entry) => entry.id),
    ['priority-sched'],
  );
  assert.deepEqual([data.difficulty, data.change, data.stuck], ['easy', 'kept', null]);
});

test('a concept failing at easy twice is stuck: notes are listed, and skipping moves the path on', async () => {
  const coursePath = {
    ...lab.RR_PATH,
    path: lab.RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)),
  };
  const h = await lab.harness({ agent: lab.team({ path: coursePath }) });
  const id = await lab.confirmedCourse(h);
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
  assert.deepEqual(estimate.stuck, { notes: [{ id: 'RR 入队顺序.md', title: 'RR 入队顺序' }] });
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
  const h = await lab.harness({ agent: lab.team() });
  const id = await lab.confirmedCourse(h);
  await gradeOnce(h, 'round-robin', 0, { difficulty: 'medium', digest: 'd1' });
  await gradeOnce(h, 'round-robin', 0, { difficulty: 'medium', digest: 'd2' });
  const estimate = (await h.call(CHANNELS.requirementsLabEstimate, id)).data;
  assert.deepEqual([estimate.difficulty, estimate.change, estimate.stuck], ['easy', 'lowered', null]);
});

const labFolder = lab.labFolder;

test('a lab whose self-check passed creates the lab repository and opens with its first stage', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await lab.confirmedCourse(h);
  const before = h.repositories.current!.id;
  await h.call(CHANNELS.requirementsLabGenerate, id);
  const generated = await settleLab(h, id);
  assert.deepEqual([generated.course.lab.status, generated.course.lab.stage, generated.course.lab.placed], ['ready', 1, false]);
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).error.code, 'lab_not_placed');
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id)).error.field, 'root');
  const root = await labFolder();
  const { data, error } = await h.call(CHANNELS.requirementsLabPlace, id, root);
  assert.equal(error, undefined, JSON.stringify(error));
  const labRepository = h.repositories.current!.id;
  assert.notEqual(labRepository, before);
  assert.equal(data.course.repositoryId, labRepository);
  assert.equal(data.course.lab.placed, true);
  assert.deepEqual(
    (await h.call(CHANNELS.tasksList)).data.map((task) => [task.id, task.lab.stage, task.concepts]),
    [['lab-round-robin', 1, ['round-robin']]],
  );
  assert.equal((await h.call(CHANNELS.requirementsGet, id)).data.course.repositoryId, labRepository);
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id, root)).error.code, 'invalid_state');
});

test('the next stage waits for the last lab, then is generated against the repository as stage 2', async () => {
  const seen: Record<string, string>[] = [];
  const stages = async (files: Record<string, string>) => {
    seen.push(files);
    const results: Record<string, boolean> = {};
    for (const [file, script] of Object.entries(files)) {
      if (!file.startsWith('tests/public/')) continue;
      const solved = file.startsWith('tests/public/01_') ? files['src/rr.c'] === lab.RR_CODE.solution[0].content : files['src/prio.c'] === '// done\n';
      for (const match of script.matchAll(/^(?:check "|echo "ok - )([^"]+)"/gm)) results[match[1]] = solved;
    }
    return lab.graded(results);
  };
  const specs = [lab.RR_SPEC, lab.PRIORITY_SPEC];
  const codes = [lab.RR_CODE, lab.PRIORITY_CODE];
  const coursePath = {
    ...lab.RR_PATH,
    path: lab.RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)),
  };
  const base = lab.team({ path: coursePath });
  const agent = async (options: Parameters<fixtures.FakeAgent>[0]) => {
    const keys = Array.isArray(options.schema.required) ? options.schema.required : [];
    if (keys.includes('id') && keys.includes('hiddenTests')) return { output: specs.shift(), costUsd: 0.4 };
    if (keys.includes('starter') && keys.includes('solution') && keys.length === 3) return { output: codes.shift(), costUsd: 0.4 };
    if (keys.includes('mutants') && !specs.length && !codes.length && options.prompt.includes('src/prio.c'))
      return { output: lab.PRIORITY_MUTANTS, costUsd: 0.1 };
    return base(options);
  };
  const h = await lab.harness({ agent, labGrader: stages });
  const id = await lab.confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h, id);
  await h.call(CHANNELS.requirementsLabPlace, id, await labFolder());
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).error.code, 'previous_lab_open');
  await gradeOnce(h, 'round-robin', 3, { hintLevel: 3, digest: 'd1' });
  await fs.writeFile(path.join(h.getConfig().root!, 'src/rr.c'), lab.RR_CODE.solution[0].content);
  await h.store.transition('lab-round-robin', 'claim', 'human', { baseline: 'abc', mode: 'practice' });
  await h.store.transition('lab-round-robin', 'submit_for_review', 'human');
  await h.store.transition('lab-round-robin', 'review_accepted', 'agent');
  assert.equal(h.store.get('lab-round-robin').status, 'done');
  seen.length = 0;
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).error, undefined);
  const second = await settleLab(h, id);
  assert.deepEqual([second.course.lab.status, second.course.lab.stage, second.course.lab.concepts], ['ready', 2, ['priority-sched']]);
  assert.ok('tests/public/01_rr.sh' in seen[0] && 'src/rr.c' in seen[0] && 'tests/public/02_prio.sh' in seen[0]);
  const project = path.join(h.getConfig().root!, 'taskpilot.toml');
  await fs.writeFile(project, `${await fs.readFile(project, 'utf8')}# learner note\n`);
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id)).error.code, 'lab_files_changed');
  await fixtures.run('git', ['-C', h.getConfig().root!, 'commit', '-qam', 'note']);
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id)).error, undefined);
  assert.match(await fs.readFile(project, 'utf8'), /# learner note/);
  assert.deepEqual(
    (await h.call(CHANNELS.tasksList)).data.map((task) => [task.id, task.lab.stage, task.dependsOn]),
    [
      ['lab-round-robin', 1, []],
      ['lab-priority-sched', 2, ['lab-round-robin']],
    ],
  );
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id)).error.code, 'invalid_state');
});

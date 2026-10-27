// Course lab repositories (src/main/lab_service.ts): created from a fixture,
// claimed, submitted and checked by QA's public tests; the private parts of
// each lab never reach git, the renderer or a Coding Agent run directory.
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as labs from '../../../src/main/labs.ts';
import * as workspace from '../../../src/main/workspace.ts';
import { env } from '../../../src/main/env.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { FCFS_LAB, HIDDEN_MARKERS, REFERENCE_MARKERS, RR_LAB, SCHED_PLAN } from '../fixtures/sched_lab.ts';
import * as fixtures from './harness.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';

// Runs real git and make per test.
vi.setConfig({ testTimeout: 60_000 });

const hasTools = (await Promise.all(['cc', 'make'].map((tool) => workspace.resolveExecutable(tool, { envPath: env.path }).then(Boolean)))).every(Boolean);

const PRIVATE_MARKERS = [...REFERENCE_MARKERS, ...HIDDEN_MARKERS, 'hint-marker'];
const FCFS = { ...FCFS_LAB, private: { ...FCFS_LAB.private, hints: [{ level: 1, text: 'hint-marker 先排序。', code: null }] } };

const emptyFolder = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-repo-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  // macOS /tmp is /private/tmp, as git reports it.
  return fs.realpath(dir);
};

// Every channel's answer the renderer could read about the lab packages.
const rendererView = async (call: fixtures.TestCall) =>
  JSON.stringify([
    await call(CHANNELS.listTasks),
    await call(CHANNELS.getTask, 'lab-fcfs'),
    await call(CHANNELS.getTask, 'lab-round-robin'),
    await call(CHANNELS.requirementsList),
    await call(CHANNELS.repositoriesList),
    await call(CHANNELS.workspaceGet),
  ]);

const settleTask = async (call: fixtures.TestCall, id: string, done: (task: TaskView) => boolean) => {
  for (let i = 0; i < 1000; i += 1) {
    const response = await call(CHANNELS.getTask, id);
    const task = (response.ok ? response.data : null) as TaskView;
    if (done(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${id} never settled`);
};

const git = async (root: string, ...args: string[]) => (await fixtures.run('git', ['-C', root, ...args])).stdout;

const labHarness = async () => {
  const prepared: string[] = [];
  const h = await fixtures.harness({
    agent: fixtures.fakeAgent(),
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => {
        prepared.push(options!.runName!);
        return { runName: options!.runName!, directory: options!.runName! };
      },
    },
  });
  // The lab repository gets the same commit identity as the harness's own.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-home-'));
  onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  await fs.writeFile(path.join(home, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
  onTestFinished(() => void vi.unstubAllEnvs());
  return { ...h, prepared };
};

test('a lab repository is created, committed, opened and published as a chain of practice packages', async () => {
  const h = await labHarness();
  const root = await emptyFolder();
  const entry = await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: [FCFS, RR_LAB] });

  assert.equal(h.repositories.current?.id, entry.id);
  assert.equal(h.getConfig().root, root);
  assert.equal((await git(root, 'status', '--porcelain')).trim(), '', 'everything written is committed');
  assert.equal((await git(root, 'rev-list', '--count', 'HEAD')).trim(), '1');
  const tracked = (await git(root, 'ls-files')).trim().split('\n');
  assert.deepEqual(tracked, [
    '.gitignore',
    '.taskpilot/course_plan.toml',
    'Makefile',
    'labs/01-fcfs/README.md',
    'labs/02-round-robin/README.md',
    'src/fcfs.c',
    'src/rr.c',
    'taskpilot.toml',
    'tests/build.mk',
    'tests/grade.sh',
    'tests/public/01_fcfs.sh',
    'tests/public/02_rr.sh',
  ]);
  assert.match(await fs.readFile(path.join(root, labs.COURSE_PLAN_PATH), 'utf8'), /conceptId = "round-robin"/);

  const queue = (await h.call(CHANNELS.listTasks)).data as TaskView[];
  assert.deepEqual(
    queue.map((task) => [task.id, task.dependsOn, task.lab?.stage, task.recommendedMode?.mode]),
    [
      ['lab-fcfs', [], 1, 'practice'],
      ['lab-round-robin', ['lab-fcfs'], 2, 'practice'],
    ],
  );
  assert.equal(queue[0].course?.id, 'os');
  assert.ok(!queue[1].humanTransitions.includes('claim'), 'stage 2 waits for stage 1');
  const { data: view } = await h.call(CHANNELS.workspaceGet);
  assert.equal(view.course.ref.id, 'os');

  // The private parts are in the repository's data directory only.
  const privateDir = labs.labDir(h.repositories.dataDir(entry.id), 'round-robin');
  assert.equal(await fs.readFile(path.join(privateDir, labs.REFERENCE_FILENAME), 'utf8'), RR_LAB.private.reference);
  assert.deepEqual(await fs.readdir(path.join(privateDir, labs.HIDDEN_DIRNAME)), ['02_rr_arrival.sh']);
  assert.ok(path.relative(root, privateDir).startsWith('..'), 'outside the repository');
});

test.skipIf(!hasTools)('a lab is claimed with its reference ready, submitted, and QA runs the public tests of every stage', async () => {
  const h = await labHarness();
  const root = await emptyFolder();
  await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: [FCFS] });

  await h.call(CHANNELS.transition, 'lab-fcfs', 'claim', { mode: 'practice' });
  const claimed = await settleTask(h.call, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');
  assert.equal(claimed.referenceRun!.source, 'lab');
  assert.deepEqual(claimed.referenceRun!.files, [{ path: 'src/fcfs.c', added: 17, removed: 4 }]);
  assert.equal(claimed.referenceRun!.costUsd, 0);
  assert.equal(h.prepared.length, 0, 'no Coding Agent run is started for a lab reference');

  await solve(root, FCFS);
  await h.call(CHANNELS.transition, 'lab-fcfs', 'submit_for_review');
  const reviewed = await settleTask(h.call, 'lab-fcfs', (task) => task.review?.status !== 'running');
  const review = reviewed.review!;
  assert.ok(review.status === 'passed', JSON.stringify(review));
  const grade = review.checks.find((check) => check.kind === 'custom:grade');
  assert.equal(grade?.status, 'pass');
  assert.equal(grade?.blocking, true);
  assert.equal(review.acceptance[0].status, 'verified');
  const qaPrompt = fixtures.callFor(h.agentCalls, 'review').prompt;
  for (const marker of [...HIDDEN_MARKERS, 'hint-marker']) assert.ok(!qaPrompt.includes(marker), marker);

  // Once QA has judged, the reference opens as it does for any practice package.
  assert.equal((await h.call(CHANNELS.referenceGet, 'lab-fcfs')).data, FCFS.private.reference);
});

// Applies a lab's reference to the working tree, as a student's solution.
const solve = async (root: string, lab: labs.LabArtifact) => {
  await fs.writeFile(path.join(root, 'ref.patch'), lab.private.reference);
  await fixtures.run('git', ['-C', root, 'apply', 'ref.patch']);
  await fs.rm(path.join(root, 'ref.patch'));
};

test.skipIf(!hasTools)('a stage 2 submission that breaks stage 1 is rejected by the regression tests', async () => {
  const h = await labHarness();
  const root = await emptyFolder();
  await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: [FCFS, RR_LAB] });
  // Stage 1 was finished and committed before stage 2 was claimed.
  await solve(root, FCFS);
  await fixtures.run('git', ['-C', root, 'commit', '-qam', 'fcfs']);
  await h.call(CHANNELS.waiveDependency, 'lab-round-robin', 'lab-fcfs');
  await h.call(CHANNELS.transition, 'lab-round-robin', 'claim', { mode: 'practice' });
  const claimed = await settleTask(h.call, 'lab-round-robin', (task) => task.baselineChecks?.status === 'measured');
  assert.equal(claimed.referenceRun?.status, 'ready');
  // Round robin done, and first come first served broken on the way.
  await solve(root, RR_LAB);
  await fs.writeFile(path.join(root, 'src/fcfs.c'), FCFS.files['src/fcfs.c']);
  await h.call(CHANNELS.transition, 'lab-round-robin', 'submit_for_review');
  const review = (await settleTask(h.call, 'lab-round-robin', (task) => task.review?.status !== 'running')).review!;
  assert.ok(review.status === 'rejected', JSON.stringify(review));
  assert.ok(review.reasons.includes('tests_failed'));
  assert.equal(review.acceptance[0].status, 'verified', 'its own test passes');
});

test('private lab files never reach git, the renderer or a Coding Agent run directory', async () => {
  const h = await labHarness();
  const root = await emptyFolder();
  const entry = await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: [FCFS] });
  await h.labs.addLab(RR_LAB);

  // git: neither the history nor any tracked blob holds a private marker.
  const history = await git(root, 'log', '-p', '--all');
  for (const marker of PRIVATE_MARKERS) assert.ok(!history.includes(marker), `git history: ${marker}`);
  assert.ok(!history.includes('hidden/') && !history.includes(labs.REFERENCE_FILENAME));

  // A Coding Agent run directory is the baseline's `git archive`.
  const archive = (await fixtures.run('git', ['-C', root, 'archive', '--format=tar', 'HEAD'], { encoding: 'latin1', maxBuffer: 16 * 1024 * 1024 })).stdout;
  for (const marker of PRIVATE_MARKERS) assert.ok(!archive.includes(marker), `run directory: ${marker}`);
  assert.ok(!path.resolve(h.repositories.dataDir(entry.id)).startsWith(`${root}${path.sep}`), 'the private directory is outside the repository');

  // IPC: before and after a claim, nothing the renderer can read holds them.
  await h.call(CHANNELS.transition, 'lab-fcfs', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');
  const seen = await rendererView(h.call);
  for (const marker of PRIVATE_MARKERS) assert.ok(!seen.includes(marker), `IPC: ${marker}`);
  assert.equal((await h.call(CHANNELS.referenceGet, 'lab-fcfs')).error.code, 'reference_locked');
});

test("the next lab is written and committed by TaskPilot, keeping the student's edits to taskpilot.toml", async () => {
  const h = await labHarness();
  const root = await emptyFolder();
  await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: [FCFS] });
  const project = path.join(root, 'taskpilot.toml');
  await fs.writeFile(project, `${await fs.readFile(project, 'utf8')}# my note\n`);
  // An uncommitted edit to a file the lab rewrites stops it.
  assert.equal((await h.labs.addLab(RR_LAB).catch((error) => error)).code, 'lab_files_changed');
  await fixtures.run('git', ['-C', root, 'commit', '-qam', 'note']);

  const added = await h.labs.addLab({ ...RR_LAB, build: null });
  assert.deepEqual(
    added.map((definition) => [definition.id, definition.dependsOn]),
    [['lab-round-robin', ['lab-fcfs']]],
  );
  assert.equal((await git(root, 'status', '--porcelain')).trim(), '');
  assert.match(await git(root, 'log', '-1', '--format=%s'), /第 2 阶段/);
  const text = await fs.readFile(project, 'utf8');
  assert.match(text, /# my note/);
  assert.match(text, /stage = 2/);
  assert.equal(await fs.readFile(path.join(root, 'tests/build.mk'), 'utf8'), FCFS.build, 'a lab without build rules keeps the old ones');
  assert.deepEqual(
    ((await h.call(CHANNELS.listTasks)).data as TaskView[]).map((task) => task.id),
    ['lab-fcfs', 'lab-round-robin'],
  );
  assert.equal((await h.labs.addLab(RR_LAB).catch((error) => error)).field, 'id', 'a lab id is used once');
});

test('a lab repository needs an empty folder outside any repository and a known course pack', async () => {
  const h = await labHarness();
  const busy = await emptyFolder();
  await fs.writeFile(path.join(busy, 'x'), '');
  const reasons = [
    await h.labs.createRepository({ root: busy, course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    await h.labs.createRepository({ root: path.join(h.root, 'sub'), course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    await h.labs.createRepository({ root: 'relative', course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    await h.labs
      .createRepository({ root: await emptyFolder(), course: 'nope', plan: { ...SCHED_PLAN, course: 'nope' }, labs: [FCFS] })
      .catch((error) => error.code),
    await h.labs.createRepository({ root: await emptyFolder(), course: 'os', plan: SCHED_PLAN, labs: [] }).catch((error) => error.code),
  ];
  assert.deepEqual(reasons, ['root_not_empty', 'root_not_found', 'root_not_absolute', 'unknown_course', 'invalid_lab']);
  const inside = path.join(h.root, 'nested');
  await fs.mkdir(inside);
  assert.equal(
    await h.labs.createRepository({ root: inside, course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    'root_in_repository',
  );
  // Nothing was added or opened.
  assert.equal(h.repositories.list().length, 1);
  // A project repository is not a lab repository.
  assert.equal((await h.labs.addLab(RR_LAB).catch((error) => error)).code, 'not_lab_repository');
});

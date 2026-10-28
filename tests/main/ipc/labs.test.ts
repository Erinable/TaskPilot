// Course lab repositories (src/main/courses/lab_service.ts): created from a fixture,
// claimed, submitted and checked by QA's public tests; the private parts of
// each lab never reach git, the renderer or a Coding Agent run directory.
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as labs from '../../../src/main/courses/labs.ts';
import * as verification from '../../../src/main/checking/verification.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { FCFS_LAB, HIDDEN_MARKERS, REFERENCE_MARKERS, RR_LAB, SCHED_PLAN } from '../fixtures/sched_lab.ts';
import * as requiredTools from '../../fixtures/required_tools.ts';
import * as fixtures from './harness.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { LabArtifact } from '../../../src/main/courses/labs.ts';
import type { Grader } from '../../../src/main/courses/lab_verify.ts';

// Runs real git and make per test.
vi.setConfig({ testTimeout: 60_000 });

const hasTools = await requiredTools.hasTools('cc', 'make');

const PRIVATE_MARKERS = [...REFERENCE_MARKERS, ...HIDDEN_MARKERS, 'hint-marker'];
const FCFS = { ...FCFS_LAB, private: { ...FCFS_LAB.private, hints: [{ level: 1, text: 'hint-marker 先排序。', code: null }] } };

const emptyFolder = async (shutdown: () => Promise<void> | undefined) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-repo-'));
  onTestFinished(async () => {
    await shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  // macOS /tmp is /private/tmp, as git reports it.
  return fs.realpath(dir);
};

const createRepository = async (h, definitions: LabArtifact[] = [FCFS]) => {
  const root = await emptyFolder(h.shutdown);
  const entry = await h.labs.createRepository({ root, course: 'os', plan: SCHED_PLAN, labs: definitions });
  return { root, entry };
};

// Every channel's answer the renderer could read about the lab packages.
const rendererView = async (call: fixtures.TestCall) =>
  JSON.stringify([
    await call(CHANNELS.tasksList),
    await call(CHANNELS.tasksGet, 'lab-fcfs'),
    await call(CHANNELS.tasksGet, 'lab-round-robin'),
    await call(CHANNELS.requirementsList),
    await call(CHANNELS.repositoriesList),
    await call(CHANNELS.workspaceGet),
  ]);

const settleTask = async (h: { call: fixtures.TestCall; idle: () => Promise<void> }, id: string, done: (task: TaskView) => boolean) => {
  await h.idle();
  const response = await h.call(CHANNELS.tasksGet, id);
  assert.equal(response.ok, true);
  const task = response.data as TaskView;
  assert.ok(done(task), `${id} did not reach the expected state: ${JSON.stringify(task)}`);
  return task;
};

const git = async (root: string, ...args: string[]) => (await fixtures.run('git', ['-C', root, ...args])).stdout;

// `make grade` on the files the review hands over, like the sandboxed
// grader but unsandboxed: the fixture's code is ours. Keeps what it saw.
const plainGrader =
  (seen: Record<string, string>[]): Grader =>
  async (files, { signal, envPath }) => {
    seen.push(files);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-grade-'));
    try {
      for (const [file, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await fs.writeFile(path.join(dir, file), content);
      }
      const run = await verification.run({ root: dir, commands: { grade: { command: 'make', args: ['grade'] } } }, 'grade', { signal, envPath });
      return { built: run.exitCode === 0, results: Object.fromEntries(run.results.map((entry) => [entry.name, entry.passed])), output: run.output };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

const labHarness = async ({ grader, agent }: { grader?: Grader; agent?: fixtures.FakeAgent } = {}) => {
  const prepared: string[] = [];
  const graded: Record<string, string>[] = [];
  const h = await fixtures.harness({
    labGrader: grader ?? plainGrader(graded),
    agent: agent ?? fixtures.fakeAgent(),
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
  return { ...h, prepared, graded };
};

test('a lab repository is created and opened with its staged packages', async () => {
  const h = await labHarness();
  const { root, entry } = await createRepository(h, [FCFS, RR_LAB]);

  assert.equal(h.repositories.current?.id, entry.id);
  assert.equal(h.getConfig().root, root);
  const queue = (await h.call(CHANNELS.tasksList)).data as TaskView[];
  assert.deepEqual(
    queue.map((task) => [task.id, task.dependsOn, task.lab?.stage, task.recommendedMode?.mode]),
    [
      ['lab-fcfs', [], 1, 'practice'],
      ['lab-round-robin', ['lab-fcfs'], 2, 'practice'],
    ],
  );
  assert.equal(queue[0].course?.id, 'os');
  assert.ok(!queue[1].humanTransitions.includes('claim'));
  assert.equal((await h.call(CHANNELS.workspaceGet)).data.course.ref.id, 'os');
});

test.skipIf(!hasTools)('a lab is claimed with its reference ready, submitted, and QA runs the public tests of every stage', async () => {
  const h = await labHarness();
  const { root } = await createRepository(h);

  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'claim', { mode: 'practice' });
  const claimed = await settleTask(h, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');
  assert.equal(claimed.referenceRun!.source, 'lab');
  assert.deepEqual(claimed.referenceRun!.files, [{ path: 'src/fcfs.c', added: 17, removed: 4 }]);
  assert.equal(claimed.referenceRun!.costUsd, 0);
  assert.equal(h.prepared.length, 0, 'no Coding Agent run is started for a lab reference');

  await solve(root, FCFS);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'submit_for_review');
  const reviewed = await settleTask(h, 'lab-fcfs', (task) => task.review?.status !== 'running');
  const review = reviewed.review!;
  assert.ok(review.status === 'passed', JSON.stringify(review));
  const grade = review.checks.find((check) => check.kind === 'custom:grade');
  assert.equal(grade?.status, 'pass');
  assert.equal(grade?.blocking, true);
  assert.equal(review.acceptance[0].status, 'verified');
  const hidden = review.checks.find((check) => check.kind === 'custom:hidden-tests');
  assert.equal(hidden?.status, 'pass');
  assert.equal(hidden?.blocking, true);
  assert.ok(!review.attention.some((item) => 'kind' in item && item.kind === 'custom:hidden-tests'), 'no baseline is expected for hidden tests');
  // The hidden tests ran on the student's tree with TaskPilot's own Makefile.
  assert.equal(h.graded.length, 1);
  assert.ok(Object.keys(h.graded[0]).includes('tests/public/01_fcfs_order.sh'));
  assert.equal(h.graded[0].Makefile, labs.MAKEFILE);
  const qaPrompt = fixtures.callFor(h.agentCalls, 'review').prompt;
  for (const marker of [...HIDDEN_MARKERS, 'hint-marker']) assert.ok(!qaPrompt.includes(marker), marker);

  // Every test passed, so the reference opens.
  assert.deepEqual(reviewed.referenceLock, { unlocked: true, reason: 'tests_passed' });
  assert.equal((await h.call(CHANNELS.practiceReference, 'lab-fcfs')).data, FCFS.private.reference);
});

// Passes the public tests (their jobs come in arrival order) but runs every
// job in input order, so the hidden "out of arrival order" test fails.
const unsorted = async (root: string) => {
  await solve(root, FCFS);
  const file = path.join(root, 'src/fcfs.c');
  const solved = await fs.readFile(file, 'utf8');
  const sorting = solved.slice(solved.indexOf('  for (int i = 1; i < count; i++) {'), solved.indexOf('  int time = 0;'));
  assert.ok(sorting.includes('jobs[at] = current;'));
  await fs.writeFile(file, solved.replace(sorting, ''));
};

// [人工决策-2026-10-27 00:51:12] 隐藏测试失败驳回提交，UI 和 IPC 只给测试名，参考答案保持锁定。
test.skipIf(!hasTools)('a failing hidden test rejects the submission; only its name reaches QA and the renderer', async () => {
  const h = await labHarness();
  const { root } = await createRepository(h);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'claim', { mode: 'practice' });
  await settleTask(h, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');

  await unsorted(root);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'submit_for_review');
  const reviewed = await settleTask(h, 'lab-fcfs', (task) => task.review?.status !== 'running');
  const review = reviewed.review!;
  assert.ok(review.status === 'rejected', JSON.stringify(review));
  assert.ok(review.reasons.includes('tests_failed'));
  assert.equal(review.checks.find((check) => check.kind === 'custom:grade')?.status, 'pass', 'the public tests pass');
  const hidden = review.checks.find((check) => check.kind === 'custom:hidden-tests')!;
  assert.equal(hidden.status, 'fail');
  assert.equal(hidden.reason, 'hidden_failed');
  assert.deepEqual(hidden.newFailures, ['fcfs sorts jobs given out of arrival order']);
  assert.ok(hidden.run && !('error' in hidden.run));
  assert.equal(hidden.run.outputTail, null);
  assert.equal(hidden.run.command, 'make grade (hidden tests)');

  // Neither the script nor its input or expected value is anywhere the renderer reads.
  const script = FCFS.private.hidden['01_fcfs_order.sh'];
  const seen = await rendererView(h.call);
  for (const secret of ['hidden-marker-fcfs', "printf 'b 2 1", 'a 1\\nb 3', script]) assert.ok(!seen.includes(secret), secret);
  assert.deepEqual(reviewed.referenceLock, { unlocked: false, reason: 'tests_not_passed' });
  assert.equal((await h.call(CHANNELS.practiceReference, 'lab-fcfs')).error.code, 'reference_locked');
});

test.skipIf(!hasTools)('hidden tests that cannot run leave the check unverifiable and the reference locked', async () => {
  // The refusal is logged by runHiddenTests; it is expected here.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const h = await labHarness({
    grader: async () => {
      throw Object.assign(new Error('no sandbox'), { code: 'sandbox_unavailable' });
    },
  });
  const { root } = await createRepository(h);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'claim', { mode: 'practice' });
  await settleTask(h, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');
  await solve(root, FCFS);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'submit_for_review');
  const reviewed = await settleTask(h, 'lab-fcfs', (task) => task.review?.status !== 'running');
  const review = reviewed.review!;
  assert.ok(review.status === 'passed', JSON.stringify(review));
  const hidden = review.checks.find((check) => check.kind === 'custom:hidden-tests')!;
  assert.deepEqual([hidden.status, hidden.reason], ['unverifiable', 'sandbox_unavailable']);
  // The human sees it at acceptance; an unverifiable check is not a pass.
  assert.ok(review.attention.some((item) => item.code === 'check_unverifiable' && item.kind === 'custom:hidden-tests'));
  assert.deepEqual(reviewed.referenceLock, { unlocked: false, reason: 'tests_not_passed' });
});

// Applies a lab's reference to the working tree, as a student's solution.
const solve = async (root: string, lab: labs.LabArtifact) => {
  await fs.writeFile(path.join(root, 'ref.patch'), lab.private.reference);
  await fixtures.run('git', ['-C', root, 'apply', 'ref.patch']);
  await fs.rm(path.join(root, 'ref.patch'));
};

test.skipIf(!hasTools)('a stage 2 submission that breaks stage 1 is rejected by the regression tests', async () => {
  const h = await labHarness();
  const { root } = await createRepository(h, [FCFS, RR_LAB]);
  // Stage 1 was finished and committed before stage 2 was claimed.
  await solve(root, FCFS);
  await fixtures.run('git', ['-C', root, 'commit', '-qam', 'fcfs']);
  await h.call(CHANNELS.packagesWaiveDependency, 'lab-round-robin', 'lab-fcfs');
  await h.call(CHANNELS.packagesTransition, 'lab-round-robin', 'claim', { mode: 'practice' });
  const claimed = await settleTask(h, 'lab-round-robin', (task) => task.baselineChecks?.status === 'measured');
  assert.equal(claimed.referenceRun?.status, 'ready');
  // Round robin done, and first come first served broken on the way.
  await solve(root, RR_LAB);
  await fs.writeFile(path.join(root, 'src/fcfs.c'), FCFS.files['src/fcfs.c']);
  await h.call(CHANNELS.packagesTransition, 'lab-round-robin', 'submit_for_review');
  const review = (await settleTask(h, 'lab-round-robin', (task) => task.review?.status !== 'running')).review!;
  assert.ok(review.status === 'rejected', JSON.stringify(review));
  assert.ok(review.reasons.includes('tests_failed'));
  assert.equal(review.acceptance[0].status, 'verified', 'its own test passes');
});

test('private lab files never reach git, the renderer or a Coding Agent run directory', async () => {
  const h = await labHarness();
  const { root, entry } = await createRepository(h);
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
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'claim', { mode: 'practice' });
  await settleTask(h, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');
  const seen = await rendererView(h.call);
  for (const marker of PRIVATE_MARKERS) assert.ok(!seen.includes(marker), `IPC: ${marker}`);
  assert.equal((await h.call(CHANNELS.practiceReference, 'lab-fcfs')).error.code, 'reference_locked');
});

test('a lab repository refuses unsafe roots without switching repositories', async () => {
  const h = await labHarness();
  const inside = path.join(h.root, 'nested');
  await fs.mkdir(inside);
  assert.equal(
    await h.labs.createRepository({ root: inside, course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    'root_in_repository',
  );
  assert.equal(
    await h.labs.createRepository({ root: 'relative', course: 'os', plan: SCHED_PLAN, labs: [FCFS] }).catch((error) => error.code),
    'root_not_absolute',
  );
  assert.equal(h.repositories.list().length, 1);
});

// [人工决策-2026-10-27 00:36:21] Tutor 失败时回退到 lab 预生成的 hints.json；隐藏测试从不进 Tutor 的 prompt。
test("Tutor falls back on the lab's own hint ladder and never sees the hidden tests", async () => {
  let tutorFails = false;
  const agent: fixtures.FakeAgent = async (options) => {
    if (tutorFails && fixtures.stepOf(options.schema) === 'tutor') throw Object.assign(new Error('CLI crashed'), { code: 'agent_failed' });
    return fixtures.fakeAgent()(options);
  };
  const h = await labHarness({ agent });
  await createRepository(h);
  await h.call(CHANNELS.packagesTransition, 'lab-fcfs', 'claim', { mode: 'practice' });
  await settleTask(h, 'lab-fcfs', (task) => task.referenceRun?.status === 'ready');

  // Tutor answers step 1 itself; its prompt holds nothing private.
  await h.call(CHANNELS.tutorAsk, 'lab-fcfs', 0, 1);
  assert.equal((await fixtures.settleTutor(h.call, 'lab-fcfs', 0)).levels[0].source, 'tutor');
  const prompt = fixtures.callFor(h.agentCalls, 'tutor').prompt;
  for (const marker of PRIVATE_MARKERS) assert.ok(!prompt.includes(marker), marker);

  // Tutor fails at step 2: the lab's L1 hint stands in and counts as opened.
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  tutorFails = true;
  await h.call(CHANNELS.tutorAsk, 'lab-fcfs', 1, 1);
  const fallback = await fixtures.settleTutor(h.call, 'lab-fcfs', 1);
  assert.equal(fallback.status, 'done');
  assert.deepEqual([fallback.levels[0].source, fallback.levels[0].answer.explanation], ['lab', 'hint-marker 先排序。']);
  assert.deepEqual(
    h.store.get('lab-fcfs').hints.map((use) => [use.stepIndex, use.level]),
    [
      [0, 1],
      [1, 1],
    ],
  );
  // The lab has no L2 hint: the failure shows and can be retried.
  await h.call(CHANNELS.tutorAsk, 'lab-fcfs', 1, 2);
  const failed = await fixtures.settleTutor(h.call, 'lab-fcfs', 1);
  assert.deepEqual([failed.status, failed.pending, failed.opened], ['failed', 2, 1]);
});

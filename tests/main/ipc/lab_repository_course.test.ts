/** @module-tag integration */
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as courses from '../../../src/main/courses/courses.ts';
import { courseText, contentHash } from '../../../src/main/courses/course_file.ts';
import { RepositoryRegistry, repositoryId } from '../../../src/main/repository/repositories.ts';
import { RequirementStore } from '../../../src/main/requirements/requirement_store.ts';
import { WorkPackageStore } from '../../../src/main/work_packages/work_package_store.ts';
import type { Review } from '../../../src/shared/ipc/packages.ts';
import { MasteryStore } from '../../../src/main/courses/mastery_store.ts';
import { registerIpcHandlers } from '../../../src/main/ipc.ts';
import type { IpcMainLike } from '../../../src/main/ipc/handler.ts';
import type { StructuredResult } from '../../../src/main/runtimes/claude_cli.ts';
import { buildApi } from '../../../src/shared/ipc/contract.ts';
import { CONTRACTS } from '../../../src/shared/ipc/contracts.ts';
import { createPathResolver } from '../../../src/main/infrastructure/shell_env.ts';
import { BUILTIN } from '../../fixtures/builtin_courses.ts';
import { GOAL_FORM } from '../../fixtures/course_interview.ts';
import * as lab from './lab_generation_fixtures.ts';
import * as fixtures from './harness.ts';

const PACK = { ...BUILTIN.get('os')!.pack, id: 'local-os', title: '仓库专属操作系统', labGuide: ['仓库课程内容标记：从这份课程生成 lab。'] };

const readyCourse = async ({ agent = lab.team(), labGrader = lab.passingGrader }: { agent?: fixtures.FakeAgent; labGrader?: lab.Grader } = {}) => {
  const h = await lab.harness({
    labGrader,
    agent: async (options) => {
      const response = (await agent(options)) as StructuredResult;
      if (lab.stepOf(options.schema) === 'interview') return { ...response, output: { ...(response.output as Record<string, unknown>), course: PACK.id } };
      return response;
    },
  });
  const file = path.join(h.root, courses.COURSES_DIR, `${PACK.id}.toml`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = courseText(PACK);
  await fs.writeFile(file, original);
  assert.equal((await h.call(CHANNELS.coursesSelect, PACK.id)).ok, true);
  const preview = (await h.call(CHANNELS.coursesPreview, PACK.id)).data;
  assert.equal((await h.call(CHANNELS.workspaceConfirmCourse, PACK.id, preview.ref.contentHash)).ok, true);
  const created = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: GOAL_FORM });
  await h.idle();
  const id = created.data.id;
  assert.equal((await h.call(CHANNELS.requirementsPlan, id, [''], { course: PACK.id })).ok, true);
  await h.idle();
  assert.equal((await h.call(CHANNELS.requirementsPublish, id)).ok, true);
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, id)).ok, true);
  assert.equal((await lab.settleLab(h, id)).course.lab.status, 'ready');
  return { h, id, file, original, ref: preview.ref };
};

test('repository-only course places its exact trusted snapshot, survives reload and generates the next stage with the same content', async () => {
  const base = lab.team({
    path: { ...lab.RR_PATH, path: lab.RR_PATH.path.map((entry) => (entry.conceptId === 'priority-sched' ? { ...entry, status: 'planned' } : entry)) },
  });
  let stage = 0;
  const agent: fixtures.FakeAgent = async (options) => {
    const step = lab.stepOf(options.schema);
    if (step === 'spec') stage += 1;
    if (stage === 2 && ['spec', 'code', 'mutants'].includes(step))
      return { output: { spec: lab.PRIORITY_SPEC, code: lab.PRIORITY_CODE, mutants: lab.PRIORITY_MUTANTS }[step], costUsd: 0.1 };
    return base(options);
  };
  const labGrader: lab.Grader = async (files) => {
    const results: Record<string, boolean> = {};
    for (const [file, script] of Object.entries(files)) {
      if (!file.startsWith('tests/public/')) continue;
      const solved = file.includes('/01_') ? files['src/rr.c'] === lab.RR_CODE.solution[0].content : files['src/prio.c'] === '// done\n';
      for (const match of script.matchAll(/^(?:check "|echo "ok - )([^"]+)"/gm)) results[match[1]] = solved;
    }
    return lab.graded(results);
  };
  const { h, id, file, original, ref } = await readyCourse({ agent, labGrader });
  const shadow = await courses.writeUserCourse(h.configDir, { ...PACK, title: '全局同名错误课程', labGuide: ['全局错误内容标记'] });
  await courses.confirm({ root: null, configDir: h.configDir, dataDir: h.configDir, builtin: BUILTIN }, shadow.pack, shadow.ref);
  const root = await lab.labFolder();
  const placed = await h.call(CHANNELS.requirementsLabPlace, id, root);
  assert.equal(placed.error, undefined, JSON.stringify(placed.error));
  const newId = h.repositories.current!.id;
  const selected = (await h.call(CHANNELS.workspaceGet)).data.course;
  assert.equal(selected.state.status, 'ok');
  assert.deepEqual(selected.ref, ref);
  assert.deepEqual((await courses.readRepositoryCourse(root, PACK.id)).pack, PACK);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal((await h.call(CHANNELS.tasksList)).data[0].course.contentHash, ref.contentHash);
  assert.equal(
    (await courses.loadCourse({ root: null, configDir: h.configDir, dataDir: h.configDir, builtin: BUILTIN }, shadow.ref)).pack.title,
    shadow.pack.title,
  );
  const draft = JSON.parse(await fs.readFile(lab.draftPath(h.configDir, id), 'utf8'));
  assert.deepEqual(draft.courseRef, ref);
  assert.equal((await fs.stat(lab.draftPath(h.configDir, id))).mode & 0o777, 0o600);
  const history = (await fixtures.run('git', ['-C', root, 'log', '-p', '--all'])).stdout;
  assert.ok(history.includes(`.taskpilot/courses/${PACK.id}.toml`));
  for (const marker of [lab.HIDDEN_MARKER, lab.SOLUTION_MARKER]) assert.ok(!history.includes(marker));

  // Reload the real stores and registry from disk, then exercise the IPC
  // switch/reopen path used by the app, including the persisted trust file.
  await h.shutdown();
  const registry = await new RepositoryRegistry(h.configDir).load();
  assert.equal(registry.current!.id, newId);
  const reloaded = await new RequirementStore(registry.dataDir()).load();
  const states = await new WorkPackageStore(registry.dataDir()).load(reloaded.listTasks());
  const mastery = await new MasteryStore(h.configDir).load();
  assert.equal(reloaded.get(id).course!.lab!.placed, true);
  assert.equal(states.get('lab-round-robin').status, 'pending');
  let config = await registry.loadConfig();
  const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>();
  const restarted = registerIpcHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      store: states,
      requirements: reloaded,
      mastery,
      repositories: registry,
      configDir: h.configDir,
      builtinCourses: BUILTIN,
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
      },
      pathResolver: createPathResolver({ inherited: '/usr/bin:/bin', read: async () => '/usr/bin:/bin' }),
      agents: {
        runAgent: async (options) => {
          if (lab.stepOf(options.schema) === 'spec') assert.ok(options.prompt.includes(PACK.labGuide[0]));
          assert.ok(!options.prompt.includes('全局错误内容标记'));
          return (await agent(options)) as StructuredResult;
        },
        probeAgent: async (config) => ({ command: config.cli, available: true, version: 'test', reason: null }),
        checkSignIn: async () => ({ state: 'signed_in', source: 'test' }),
      },
      labGrader,
      labProbe: fixtures.readyToolchain,
    },
  );
  onTestFinished(() => restarted.shutdown());
  const api = buildApi(CONTRACTS, {
    invoke: async (channel, ...args) => (await handlers.get(channel)!({}, ...args)) as never,
    on: () => undefined,
    removeListener: () => undefined,
  });
  const originalId = registry.list().find((entry) => entry.root === h.root)!.id;
  assert.equal((await api.repositories.switch(originalId)).ok, true);
  assert.equal((await api.repositories.switch(newId)).ok, true);
  const estimate = await api.requirements.labEstimate(id);
  assert.ok(estimate.ok);
  assert.equal(estimate.data.previousLab!.packageId, 'lab-round-robin');
  await fs.writeFile(path.join(root, 'src/rr.c'), lab.RR_CODE.solution[0].content);
  await states.transition('lab-round-robin', 'claim', 'human', { baseline: 'abc', mode: 'practice' });
  await states.transition('lab-round-robin', 'submit_for_review', 'human');
  await states.transition('lab-round-robin', 'review_accepted', 'agent');
  await mastery.record({
    mode: 'practice',
    course: PACK.id,
    concepts: ['round-robin'],
    packageId: 'lab-round-robin',
    repoId: newId,
    diffDigest: 'solved',
    review: lab.finishedReview(3) as Review,
    report: { comments: [], errorTags: [] },
    difficulty: 'easy',
    hintLevel: 3,
    at: new Date().toISOString(),
  });
  assert.equal((await api.requirements.labGenerate(id)).ok, true);
  await restarted.idle();
  const next = await api.requirements.get(id);
  assert.ok(next.ok);
  assert.equal(next.data.course!.lab!.status, 'ready');
  assert.equal(next.data.course!.lab!.stage, 2);
  // A workspace course selection must not relabel the generated packages.
  assert.equal((await api.courses.select('programming')).ok, true);
  assert.equal((await api.requirements.labPlace(id)).ok, true);
  const queue = await api.tasks.list();
  assert.ok(queue.ok);
  assert.deepEqual(
    queue.data.map((task) => [task.lab!.stage, task.course!.contentHash]),
    [
      [1, ref.contentHash],
      [2, ref.contentHash],
    ],
  );
  assert.deepEqual((await courses.readRepositoryCourse(root, PACK.id)).pack, PACK);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('changed source course is refused before placement, even when the changed content is confirmed', async () => {
  const { h, id, file, ref } = await readyCourse();
  const root = await lab.labFolder();
  const changed = { ...PACK, title: '已变更的课程' };
  await fs.writeFile(file, courseText(changed));
  assert.notEqual(contentHash(changed), ref.contentHash);
  assert.equal((await h.call(CHANNELS.workspaceConfirmCourse, PACK.id, contentHash(changed))).ok, true);
  const before = h.repositories.current!.id;
  const result = await h.call(CHANNELS.requirementsLabPlace, id, root);
  assert.equal(result.error.code, 'course_changed');
  assert.equal(h.repositories.current!.id, before);
  assert.equal(h.repositories.list().length, 1);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await h.call(CHANNELS.requirementsGet, id)).data.course.lab.placed, false);
});

test('a removed repository course cannot silently resolve to a trusted same-id global copy', async () => {
  const { h, id, file } = await readyCourse();
  const shadow = await courses.writeUserCourse(h.configDir, PACK);
  await courses.confirm({ root: null, configDir: h.configDir, dataDir: h.configDir, builtin: BUILTIN }, shadow.pack, shadow.ref);
  await fs.unlink(file);
  const root = await lab.labFolder();
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id, root)).error.code, 'course_changed');
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(h.repositories.list().length, 1);
});

test('a modified private draft snapshot is refused without writing the destination', async () => {
  const { h, id } = await readyCourse();
  const draftFile = lab.draftPath(h.configDir, id);
  const draft = JSON.parse(await fs.readFile(draftFile, 'utf8'));
  draft.request.course.title = '未确认内容';
  await fs.writeFile(draftFile, JSON.stringify(draft));
  const root = await lab.labFolder();
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id, root)).error.code, 'course_changed');
  assert.deepEqual(await fs.readdir(root), []);
});

test('a failed course copy leaves the destination empty and can be retried with the same ready draft', async () => {
  const { h, id, file, original } = await readyCourse();
  const root = await lab.labFolder();
  const writeFile = fs.writeFile;
  const before = h.repositories.current!.id;
  const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes('.taskpilot-lab-') && String(args[0]).endsWith(`${PACK.id}.toml`))
      throw Object.assign(new Error('Cannot copy course snapshot'), { code: 'EACCES' });
    return writeFile(...args);
  });
  try {
    assert.equal((await h.call(CHANNELS.requirementsLabPlace, id, root)).ok, false);
  } finally {
    failure.mockRestore();
  }
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(h.repositories.current!.id, before);
  assert.equal(h.repositories.list().length, 1);
  assert.equal((await h.call(CHANNELS.requirementsGet, id)).data.course.lab.placed, false);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal((await h.call(CHANNELS.requirementsLabPlace, id, root)).ok, true);
});

test('failed migration preserves a newer destination trust file and leaves the ready lab retryable', async () => {
  const { h, id, file, original } = await readyCourse();
  const root = await lab.labFolder();
  const destinationData = h.repositories.dataDir(repositoryId(root));
  await fs.mkdir(destinationData, { recursive: true });
  const trustFile = path.join(destinationData, courses.TRUST_FILENAME);
  const future = JSON.stringify({ version: 99, confirmed: { keep: 'future' } });
  await fs.writeFile(trustFile, future);
  const before = h.repositories.current!.id;
  const result = await h.call(CHANNELS.requirementsLabPlace, id, root);
  assert.equal(result.error.code, 'unsupported_version');
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await fs.readFile(trustFile, 'utf8'), future);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(h.repositories.current!.id, before);
  assert.equal(h.repositories.list().length, 1);
  const ready = (await h.call(CHANNELS.requirementsGet, id)).data.course;
  assert.equal(ready.repositoryId ?? null, null);
  assert.equal(ready.lab.status, 'ready');
  assert.equal(ready.lab.placed, false);
});

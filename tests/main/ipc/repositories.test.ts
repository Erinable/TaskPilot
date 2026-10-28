/** @module-tag integration */
// IPC channels of the repositories domain (src/main/ipc/repositories.ts).
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_REQUIREMENT, SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as git from '../../../src/main/repository/git.ts';
import * as fixtures from './harness.ts';
import { until } from '../../fixtures/until.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

test.each([
  ['/definitely/not/here', 'root_not_found'],
  ['projects/app', 'root_not_absolute'],
])('repositories:add rejects %s with %s', async (root, code) => {
  const { call } = await fixtures.harness({ withRepo: false });
  assert.equal((await call(CHANNELS.repositoriesAdd, root, true)).error.code, code);
});

test('repositories:add normalizes a subdirectory to the repository root', async () => {
  const root = await fixtures.gitRepo();
  const subdirectory = path.join(root, 'src');
  await fs.mkdir(subdirectory, { recursive: true });
  const { call } = await fixtures.harness({ withRepo: false });
  const { data } = await call(CHANNELS.repositoriesAdd, subdirectory, true);
  assert.equal(data.repositories[0].root, await git.topLevel(root));
});

test('repositories: a moved repository is flagged and can be pointed at its new place', async () => {
  const { call, root } = await fixtures.harness();
  const { current } = (await call(CHANNELS.repositoriesList)).data;
  const moved = `${root}-moved`;
  await fs.rename(root, moved);
  onTestFinished(() => fs.rm(moved, { recursive: true, force: true }));
  assert.equal((await call(CHANNELS.repositoriesList)).data.repositories[0].missing, true);
  const relocated = (await call(CHANNELS.repositoriesRelocate, current, moved)).data;
  assert.equal(relocated.current, current);
  assert.equal(relocated.repositories[0].missing, false);
});

test('repositories: adding without opening keeps the open repository, and the list counts work in each', async () => {
  const h = await fixtures.harness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  const other = await fixtures.gitRepo();
  const added = await h.call(CHANNELS.repositoriesAdd, other, false);
  assert.equal(added.ok, true);
  const open = added.data.repositories.find((entry) => entry.current);
  assert.equal(await fs.realpath(open.root), await fs.realpath(h.root));
  assert.equal((await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data.status, 'in_progress', 'nothing was reloaded');
  // The open repository counts from memory: the sample packages, one claimed.
  assert.equal(open.counts.active, 1);
  assert.equal(open.counts.pending, SAMPLE_TASKS.filter((task) => task.status === 'pending').length - 1);
  // The new one has no saved data yet.
  assert.deepEqual(added.data.repositories.find((entry) => !entry.current).counts, { pending: 0, active: 0, accepting: 0 });
});

test('repositories: each repository keeps its own requirements, progress and commands', async () => {
  const { call, root } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  await call(CHANNELS.workspaceSet, {
    root,
    steps: { test: { enabled: true, lines: ['npm test'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null } },
  });
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  const { data: created } = await call(CHANNELS.requirementsCreate, { text: 'first repo' });
  await fixtures.settle(call, created.id);

  const other = await fixtures.gitRepo();
  const added = (await call(CHANNELS.repositoriesAdd, other, true)).data;
  assert.equal(added.repositories.length, 2);
  assert.equal(added.repositories.find((repo) => repo.current).root, await git.topLevel(other));
  assert.deepEqual((await call(CHANNELS.requirementsList)).data, []);
  assert.deepEqual((await call(CHANNELS.tasksList)).data, []);
  assert.equal((await call(CHANNELS.workspaceGet)).data.steps.find((step) => step.id === 'test').effective, null);
  assert.equal((await call(CHANNELS.workspaceInfo)).data.root, await git.topLevel(other));

  const first = added.repositories.find((repo) => !repo.current);
  await call(CHANNELS.repositoriesSwitch, first.id);
  assert.deepEqual(
    (await call(CHANNELS.requirementsList)).data.map((item) => item.text),
    ['first repo', SAMPLE_REQUIREMENT.text],
  );
  assert.deepEqual((await call(CHANNELS.workspaceGet)).data.steps.find((step) => step.id === 'test').effective.lines, ['npm test']);
});

test('repositories: switching cancels running work and waits for its writes', async () => {
  const agent: fixtures.FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await fixtures.harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { title: '登录', text: 't' });
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'requirement', label: '登录' }]);

  const first = (await call(CHANNELS.repositoriesList)).data.current;
  await call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, []);
  await call(CHANNELS.repositoriesSwitch, first);
  const item = (await call(CHANNELS.requirementsGet, data.id)).data;
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'agent_cancelled');
});

test('repositories: switching to an unknown id is refused', async () => {
  const { call } = await fixtures.harness();
  assert.equal((await call(CHANNELS.repositoriesSwitch, 'nope')).error.code, 'unknown_repository');
});

test('repositories: switching cancels a running tutor answer so it cannot land in the next repository', async () => {
  // The answer is slow; it finishes only after cancellation or when released.
  const release = Promise.withResolvers<void>();
  let cancelled = false;
  const agent: fixtures.FakeAgent = async (options) => {
    if (fixtures.stepOf(options.schema) !== 'tutor') return fixtures.fakeAgent()(options);
    options.signal!.addEventListener('abort', () => (cancelled = true));
    await release.promise;
    return fixtures.fakeAgent()(options);
  };
  const { call } = await fixtures.harness({ agent, seedState: { 'auth-edge-tests': fixtures.claimedState } });
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0, 1);
  // Adding a repository switches to it; the switch must stop the tutor first.
  const switching = call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  await until(
    async () => cancelled,
    (value) => value,
    'tutor cancellation',
  );
  release.resolve();
  await switching;
  assert.equal(cancelled, true, 'the tutor run was not cancelled');
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, []);
});

test('repositories: a switch drops the coding events and tutor failures of the repository it leaves', async () => {
  const events = [{ sequence: 0, at: new Date().toISOString(), type: 'text' as const, text: 'done' }];
  captureExpectedErrors((error) => 'code' in error && error.code === 'agent_bad_output' && error.message === 'explanation is empty');
  const agent: fixtures.FakeAgent = async () => ({ output: { explanation: '', hints: [], snippet: null, terms: [] }, costUsd: 0 });
  const { call } = await fixtures.harness({
    agent,
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async () => ({
        output: 'done',
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
        events,
        sessionId: null,
      }),
      codingReadPatch: async () => fixtures.filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});'),
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  await call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  assert.equal((await fixtures.settleCoding(call, 'auth-edge-tests')).codingRun?.status, 'ready');
  assert.equal((await call(CHANNELS.codingEvents, 'auth-edge-tests', -1)).data.events.length, 1);
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0, 1);
  assert.equal((await fixtures.settleTutor(call, 'auth-edge-tests', 0)).status, 'failed');

  const first = (await call(CHANNELS.repositoriesList)).data.current;
  await call(CHANNELS.repositoriesAdd, await fixtures.gitRepo(), true);
  await call(CHANNELS.repositoriesSwitch, first);
  assert.equal((await call(CHANNELS.codingGet, 'auth-edge-tests')).data.codingRun?.status, 'ready');
  assert.deepEqual((await call(CHANNELS.codingEvents, 'auth-edge-tests', -1)).data.events, []);
  assert.equal((await call(CHANNELS.tutorGet, 'auth-edge-tests', 0)).data.status, 'idle');
});

// @vitest-environment happy-dom
// Tutor's per-step state: state events refresh only mounted steps, one read
// at a time; an answer for an unmounted step or an old repository is
// dropped; the last unmounted step ends the subscription.
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useTutorStore } from '@/stores/tutor.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as tutorTypes from '@shared/ipc/tutor.ts';

const state = (opened: number): tutorTypes.TutorState => ({ status: 'done', levels: [], pending: null, opened, maxLevel: 5, error: null });
const change = { repositoryId: null, domains: ['tutor' as const] };

let api: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  api = installFakeApi({ tutor: { get: () => ok(state(1)), ask: () => ok(state(2)), cancel: () => ok(true) } });
});

test('tutor events re-read every mounted step, one read at a time', async () => {
  const tutor = useTutorStore();
  await tutor.refresh('p1', 0);
  await tutor.refresh('p1', 1);
  api.tutor.get.mockClear();
  let running = 0;
  let peak = 0;
  api.tutor.get.mockImplementation(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await Promise.resolve();
    running -= 1;
    return { ok: true, data: state(3) };
  });
  api.emitState(change);
  api.emitState(change);
  await flushPromises();
  expect(peak).toBe(1);
  // A second event while the first is read only re-queues the steps: each step
  // is read at most twice, and both end on the newest state.
  const steps = api.tutor.get.mock.calls.map(([, step]) => step);
  expect(new Set(steps)).toEqual(new Set([0, 1]));
  expect(steps.length).toBeLessThanOrEqual(4);
  expect([tutor.stateOf('p1', 0)?.opened, tutor.stateOf('p1', 1)?.opened]).toEqual([3, 3]);
});

test('events for other domains or repositories read nothing', async () => {
  const tutor = useTutorStore();
  await tutor.refresh('p1', 0);
  api.tutor.get.mockClear();
  api.emitState({ repositoryId: null, domains: ['packages'] });
  api.emitState({ repositoryId: 'other', domains: ['tutor'] });
  await flushPromises();
  expect(api.tutor.get).not.toHaveBeenCalled();
});

test('an answer for a step unmounted meanwhile is not kept', async () => {
  const tutor = useTutorStore();
  // Another mounted step keeps the subscription, so only the step check can drop it.
  await tutor.refresh('p1', 1);
  await tutor.refresh('p1', 0);
  const held = Promise.withResolvers<IpcResult<tutorTypes.TutorState>>();
  api.tutor.ask.mockReturnValueOnce(held.promise);
  const asking = tutor.ask('p1', 0, 2);
  tutor.stop('p1', 0);
  held.resolve({ ok: true, data: state(2) });
  await asking;
  expect(tutor.stateOf('p1', 0)?.opened).toBe(1);
});

test('an answer from before a repository switch is dropped, though the step is mounted again', async () => {
  const tutor = useTutorStore();
  await tutor.refresh('p1', 0);
  const held = Promise.withResolvers<IpcResult<tutorTypes.TutorState>>();
  api.tutor.ask.mockReturnValueOnce(held.promise);
  const asking = tutor.ask('p1', 0, 2);
  tutor.reset();
  await tutor.refresh('p1', 0);
  held.resolve({ ok: true, data: state(4) });
  await asking;
  expect(tutor.stateOf('p1', 0)?.opened).toBe(1);
});

test('a step read that lands after its step unmounted is not kept', async () => {
  const tutor = useTutorStore();
  await tutor.refresh('p1', 1);
  const held = Promise.withResolvers<IpcResult<tutorTypes.TutorState>>();
  api.tutor.get.mockReturnValueOnce(held.promise);
  const reading = tutor.refresh('p1', 0);
  tutor.stop('p1', 0);
  held.resolve({ ok: true, data: state(2) });
  await reading;
  expect(tutor.stateOf('p1', 0)).toBeNull();
});

test('unmounting the last step ends the subscription', async () => {
  const subscribe = api.state.onChanged.getMockImplementation()!;
  let listeners = 0;
  api.state.onChanged.mockImplementation((listener) => {
    listeners += 1;
    const off = subscribe(listener);
    return () => {
      listeners -= 1;
      off();
    };
  });
  const tutor = useTutorStore();
  await tutor.refresh('p1', 0);
  await tutor.refresh('p1', 1);
  expect(listeners).toBe(1);
  tutor.stop('p1', 0);
  expect(listeners).toBe(1);
  tutor.stop('p1', 1);
  expect(listeners).toBe(0);
});

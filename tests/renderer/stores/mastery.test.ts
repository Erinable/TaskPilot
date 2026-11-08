// @vitest-environment happy-dom
// The mastery store: an older course or review answer that lands after a
// newer read or a reset is dropped.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useMasteryStore } from '@/stores/mastery.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import type * as masteryTypes from '@shared/ipc/mastery.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), announceAgent: vi.fn(), confirmAction: vi.fn(), openDialogs: { value: 0 } }));

const mastery = (id: string): masteryTypes.CourseMastery => ({ course: { id, title: id }, concepts: [], errorTypes: [], repositories: [] });
const reviews = (total: number): masteryTypes.ReviewList => ({ today: '2026-10-28', due: [], total });

let api: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  api = installFakeApi({ mastery: { course: (id?: string) => ok(mastery(id ?? 'programming')), reviews: () => ok(reviews(1)) } });
});

test('a pack picked while another loads keeps the newer pack and its loading state', async () => {
  const held = Promise.withResolvers<IpcResult<masteryTypes.CourseMastery>>();
  api.mastery.course.mockReturnValueOnce(held.promise);
  const store = useMasteryStore();
  const first = store.loadCourse('programming');
  await store.loadCourse('os');
  held.resolve({ ok: true, data: mastery('programming') });
  await first;
  expect(store.course?.course.id).toBe('os');
  expect(store.courseId).toBe('os');
  expect(store.courseLoading).toBe(false);
});

test('answers for the old repository that land after a reset are dropped', async () => {
  const course = Promise.withResolvers<IpcResult<masteryTypes.CourseMastery>>();
  const list = Promise.withResolvers<IpcResult<masteryTypes.ReviewList>>();
  api.mastery.course.mockReturnValueOnce(course.promise);
  api.mastery.reviews.mockReturnValueOnce(list.promise);
  const store = useMasteryStore();
  const loading = store.load();
  store.reset();
  course.resolve({ ok: true, data: mastery('old') });
  list.resolve({ ok: true, data: reviews(9) });
  await loading;
  expect(store.course).toBeNull();
  expect(store.reviews).toBeNull();
  expect(store.courseLoading).toBe(false);
});

test('a reset stops following state events', async () => {
  const store = useMasteryStore();
  await store.enter();
  expect(api.mastery.course).toHaveBeenCalledTimes(1);
  api.emitState({ repositoryId: null, domains: ['mastery'] });
  await flushPromises();
  expect(api.mastery.course).toHaveBeenCalledTimes(2);
  store.reset();
  api.emitState({ repositoryId: null, domains: ['mastery'] });
  await flushPromises();
  expect(api.mastery.course).toHaveBeenCalledTimes(2);
});

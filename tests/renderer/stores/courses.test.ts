// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '@/lib/feedback.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import { courseList, coursePreview, defaultCourse, fail, installApi, ok } from '../settings_fakes.ts';
import { OS_COURSE } from '@shared/course_pack.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi();
  setActivePinia(createPinia());
});

const pendingCourse = (): workspaceTypes.CourseView => {
  const ref = { id: 'oslab', version: '0.1.0', contentHash: 'b'.repeat(64), source: 'repository' as const };
  return { ...defaultCourse(), selected: { id: 'oslab', from: 'local' }, state: { status: 'pending', pack: { ...OS_COURSE, id: 'oslab' }, ref } };
};

test('selecting a pack that needs confirming opens its preview to confirm', async () => {
  api.courses.select.mockReturnValueOnce(ok(courseList({ current: pendingCourse() })));
  const courses = useCoursesStore();
  await courses.select('oslab');
  expect(api.courses.select).toHaveBeenCalledWith('oslab');
  expect(api.courses.preview).toHaveBeenCalledWith('oslab');
  expect(courses.previewOpen).toBe(true);
  expect(courses.previewMode).toBe('confirm');
});

test('selecting a built-in pack says it applies to later planning and grading', async () => {
  api.courses.select.mockReturnValueOnce(
    ok(courseList({ current: { ...defaultCourse(), selected: { id: 'os', from: 'local' }, ref: { ...defaultCourse().ref, id: 'os' } } })),
  );
  const courses = useCoursesStore();
  await courses.select('os');
  expect(courses.previewOpen).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('之后的规划和判卷改用「操作系统实验」。');
});

test('confirm() sends the hash of the content shown, and only in confirm mode', async () => {
  api.courses.list.mockReturnValue(ok(courseList({ current: pendingCourse() })));
  const courses = useCoursesStore();
  await courses.load();
  await courses.openPreview('os');
  expect(courses.previewMode).toBe('view');
  await courses.confirm();
  expect(api.workspace.confirmCourse).not.toHaveBeenCalled();

  await courses.openPreview('oslab');
  expect(courses.previewMode).toBe('confirm');
  await courses.confirm();
  expect(api.workspace.confirmCourse).toHaveBeenCalledWith('oslab', 'b'.repeat(64));
  expect(courses.previewOpen).toBe(false);
});

test('a refused confirmation reloads and shows the pack as it is now', async () => {
  api.courses.list.mockReturnValue(ok(courseList({ current: pendingCourse() })));
  api.workspace.confirmCourse.mockReturnValueOnce(fail('course_changed', 'Course pack oslab changed since it was shown'));
  const courses = useCoursesStore();
  await courses.load();
  await courses.openPreview('oslab');
  api.courses.preview.mockReturnValueOnce(ok(coursePreview('oslab', { changes: [{ field: 'title', kind: 'changed' }] })));
  await courses.confirm();
  expect(feedback.showToast).toHaveBeenCalledWith(expect.stringContaining('确认失败'));
  expect(courses.previewOpen).toBe(true);
  expect(courses.preview?.changes).toEqual([{ field: 'title', kind: 'changed' }]);
});

test('import: a picked file is previewed, then copied with its hash; cancelling the picker does nothing', async () => {
  const courses = useCoursesStore();
  await courses.pickImport();
  expect(courses.previewOpen).toBe(false);

  api.courses.pickImport.mockReturnValueOnce(ok({ ...coursePreview('net'), replaces: false, shadowed: false }));
  await courses.pickImport();
  expect(courses.previewMode).toBe('import');
  expect(api.courses.import).not.toHaveBeenCalled();
  await courses.importPicked();
  expect(api.courses.import).toHaveBeenCalledWith('b'.repeat(64));
  expect(courses.previewOpen).toBe(false);
});

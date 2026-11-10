// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import * as feedback from '@/lib/feedback.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import { useRepositoryIdentityStore } from '@/stores/repository_identity.ts';
import { courseList, coursePreview, courseSaved, defaultCourse, fail, installApi, ok } from '../settings_fakes.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import { collectLocalDrafts, draftKey } from '@/lib/local_draft.ts';
import { draftOf } from '@/lib/course_model.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
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
  expectConsole('error', /changed since it was shown/);
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

test('load errors persist until a successful retry and a refresh failure keeps known data', async () => {
  const courses = useCoursesStore();
  expectConsole('error', /disk unavailable/);
  api.courses.list.mockReturnValueOnce(fail('unknown', 'disk unavailable'));
  await courses.load();
  expect(courses.loading).toBe(false);
  expect(courses.list).toBeNull();
  expect(courses.loadError).toContain('disk unavailable');
  await courses.load();
  const known = courses.list;
  expect(courses.loadError).toBeNull();
  api.courses.list.mockReturnValueOnce(fail('unknown', 'disk unavailable'));
  await courses.load();
  expect(courses.list).toBe(known);
  expect(courses.loadError).toContain('disk unavailable');
});

test('global user drafts survive repository reset and are separate from requirement drafts', () => {
  const courses = useCoursesStore();
  courses.editDraft('user:os', OS_COURSE).title = 'global draft';
  courses.editDraft('requirement:repo-a:r1:h', OS_COURSE).title = 'interview draft';
  courses.reset();
  expect(courses.editDraft('user:os', OS_COURSE).title).toBe('global draft');
  expect(courses.editDraft('requirement:repo-a:r1:h', OS_COURSE).title).toBe('interview draft');
  expect(courses.editDraft('requirement:repo-b:r1:h', OS_COURSE).title).toBe(OS_COURSE.title);
  courses.discardDraft('user:os');
  expect(courses.editDraft('user:os', OS_COURSE).title).toBe(OS_COURSE.title);
});

test('course edits recover after restart and refuse drafts based on changed official content', () => {
  const pack = { ...OS_COURSE, id: 'mine' };
  const first = useCoursesStore();
  first.editDraft('user:mine', pack).title = '未提交的课程名';
  setActivePinia(createPinia());
  const restarted = useCoursesStore();
  expect(restarted.editDraft('user:mine', pack).title).toBe(pack.title);
  expect(restarted.editDraftState('user:mine', pack).pending).toBe(true);
  restarted.restoreDraft('user:mine', pack);
  expect(restarted.editDraft('user:mine', pack).title).toBe('未提交的课程名');
  const changed = { ...pack, summary: '外部更新' };
  expect(restarted.editDraft('user:mine', changed).summary).toBe('外部更新');
  expect(restarted.editDraftState('user:mine', changed).conflict).toBe(true);
  expect(collectLocalDrafts()[draftKey(['course', 'user:mine'])]).toContain('未提交的课程名');
});

test('saved course snapshots clear old input and retain later edits against the accepted baseline', () => {
  const pack = { ...OS_COURSE, id: 'mine' };
  const courses = useCoursesStore();
  courses.editDraft('user:mine', pack).title = '继续编辑';
  const saved = { ...pack, title: '已保存标题' };
  courses.acceptDraft('user:mine', draftOf(saved));
  setActivePinia(createPinia());
  const restarted = useCoursesStore();
  expect(restarted.editDraftState('user:mine', saved).pending).toBe(true);
  restarted.restoreDraft('user:mine', saved);
  expect(restarted.editDraft('user:mine', saved).title).toBe('继续编辑');
  restarted.discardDraft('user:mine');
  expect(collectLocalDrafts()[draftKey(['course', 'user:mine'])]).toBeUndefined();
});

test('a save returning after selecting another course or switching repositories cannot replace that view', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.save>>>();
  api.courses.save.mockReturnValueOnce(held.promise);
  const saving = courses.save({ ...OS_COURSE, id: 'mine' });
  await courses.view('os');
  held.resolve({ ok: true, data: { list: courseList(), preview: coursePreview('mine') } });
  await saving;
  expect(courses.viewed?.ref.id).toBe('os');
  const late = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.save>>>();
  api.courses.save.mockReturnValueOnce(late.promise);
  const oldSave = courses.save({ ...OS_COURSE, id: 'mine' });
  courses.reset();
  useRepositoryIdentityStore().currentId = 'repo-b';
  late.resolve({ ok: true, data: { list: courseList(), preview: coursePreview('mine') } });
  await oldSave;
  expect(courses.list).toBeNull();
  expect(courses.viewed).toBeNull();
});

test.each(['preview', 'list'] as const)('copy keeps its selection when an older refresh %s arrives afterward', async (pending) => {
  const courses = useCoursesStore();
  await courses.loadView();
  const previewHeld = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.preview>>>();
  const listHeld = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.list>>>();
  if (pending === 'preview') api.courses.preview.mockReturnValueOnce(previewHeld.promise);
  else api.courses.list.mockReturnValueOnce(listHeld.promise);
  const refreshing = courses.loadView();
  await flushPromises();
  await courses.copy('programming', 'my-copy');
  expect(courses.viewedId).toBe('my-copy');
  expect(courses.viewed?.ref.id).toBe('my-copy');
  const savedList = courses.list;
  const previewCalls = api.courses.preview.mock.calls.length;
  if (pending === 'preview') previewHeld.resolve({ ok: true, data: coursePreview('programming') });
  else listHeld.resolve({ ok: true, data: courseList() });
  await refreshing;
  expect(courses.viewedId).toBe('my-copy');
  expect(courses.viewed?.ref.id).toBe('my-copy');
  expect(courses.list).toBe(savedList);
  expect(api.courses.preview).toHaveBeenCalledTimes(previewCalls);
});

test('a copy or save invalidates a pending preview even when its old response fails', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.preview>>>();
  api.courses.preview.mockReturnValueOnce(held.promise);
  const viewing = courses.view('programming');
  await courses.copy('programming', 'mine');
  held.resolve({ ok: false, error: { code: 'unknown', message: 'old preview failed' } });
  await viewing;
  expect(courses.viewedId).toBe('mine');
  expect(courses.viewError).toBeNull();
  const stale = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.preview>>>();
  api.courses.preview.mockReturnValueOnce(stale.promise);
  const refreshing = courses.view('mine');
  api.courses.save.mockReturnValueOnce(ok(courseSaved('mine', { ...OS_COURSE, title: 'saved title' })));
  await courses.save({ ...OS_COURSE, id: 'mine', title: 'saved title' });
  stale.resolve({ ok: true, data: coursePreview('mine') });
  await refreshing;
  expect(courses.viewed?.pack.title).toBe('saved title');
  expect(courses.viewedId).toBe('mine');
});

test('a selection made while copying wins over the completed copy', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(held.promise);
  const copying = courses.copy('programming', 'mine');
  await courses.view('os');
  held.resolve({ ok: true, data: courseSaved('mine') });
  await copying;
  expect(courses.viewedId).toBe('os');
  expect(courses.viewed?.ref.id).toBe('os');
});

test('a refresh started during copying cannot consume its pending selection', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(held.promise);
  const copying = courses.copy('programming', 'mine');
  await courses.loadView();
  expect(api.courses.preview).toHaveBeenCalledTimes(1);
  held.resolve({ ok: true, data: courseSaved('mine') });
  await copying;
  expect(courses.viewedId).toBe('mine');
  expect(courses.viewed?.ref.id).toBe('mine');
});

test('confirmation does not prevent refreshes of the viewed pack trust', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  courses.preview = coursePreview('mine');
  courses.previewMode = 'confirm';
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.workspace.confirmCourse>>>();
  api.workspace.confirmCourse.mockReturnValueOnce(held.promise);
  const confirming = courses.confirm();
  await courses.loadView();
  expect(api.courses.preview).toHaveBeenCalledTimes(2);
  held.resolve(await api.workspace.get());
  await confirming;
});

test('reset drops late copy results and their busy cleanup cannot release a newer action', async () => {
  const courses = useCoursesStore();
  courses.editDraft('user:mine', OS_COURSE).title = 'global draft';
  const old = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(old.promise);
  const copying = courses.copy('programming', 'old-copy');
  courses.reset();
  useRepositoryIdentityStore().currentId = 'repo-b';
  expect(courses.busy).toBe(false);
  const latest = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(latest.promise);
  const newer = courses.copy('os', 'new-copy');
  old.resolve({ ok: true, data: courseSaved('old-copy') });
  await copying;
  expect(courses.list).toBeNull();
  expect(courses.viewedId).toBeNull();
  expect(courses.viewed).toBeNull();
  expect(courses.busy).toBe(true);
  expect(courses.drafts['user:mine'].title).toBe('global draft');
  latest.resolve({ ok: true, data: courseSaved('new-copy') });
  await newer;
  expect(courses.viewedId).toBe('new-copy');
  expect(courses.busy).toBe(false);
});

test('pending course writes guard duplicate and competing mutation actions', async () => {
  const courses = useCoursesStore();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(held.promise);
  const copying = courses.copy('programming', 'mine');
  expect(await courses.copy('programming', 'duplicate')).toMatchObject({ field: 'id' });
  expect(await courses.save({ ...OS_COURSE, id: 'mine' })).toMatchObject({ field: 'pack' });
  await courses.select('os');
  courses.preview = coursePreview('mine');
  courses.previewMode = 'confirm';
  await courses.confirm();
  courses.previewMode = 'import';
  await courses.importPicked();
  expect(api.courses.copy).toHaveBeenCalledTimes(1);
  expect(api.courses.save).not.toHaveBeenCalled();
  expect(api.courses.select).not.toHaveBeenCalled();
  expect(api.workspace.confirmCourse).not.toHaveBeenCalled();
  expect(api.courses.import).not.toHaveBeenCalled();
  expect(courses.busy).toBe(true);
  held.resolve({ ok: true, data: courseSaved('mine') });
  await copying;
  expect(courses.busy).toBe(false);
});

test('the default pack is asked for once and kept across a reset', async () => {
  const courses = useCoursesStore();
  await courses.loadDefault();
  await courses.loadDefault();
  courses.reset();
  expect(api.courses.default).toHaveBeenCalledTimes(1);
  expect(courses.defaultPack?.id).toBe('programming');
});

test('an older list answer that lands after a newer one or a reset is dropped', async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.list>>>();
  api.courses.list.mockReturnValueOnce(held.promise);
  const courses = useCoursesStore();
  const first = courses.load();
  const newer = courseList({ userDir: '/newer' });
  api.courses.list.mockReturnValueOnce(ok(newer));
  await courses.load();
  held.resolve({ ok: true, data: courseList({ userDir: '/older' }) });
  await first;
  expect(courses.list?.userDir).toBe('/newer');
  expect(courses.loading).toBe(false);

  const late = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.list>>>();
  api.courses.list.mockReturnValueOnce(late.promise);
  const loading = courses.load();
  courses.reset();
  late.resolve({ ok: true, data: courseList({ userDir: '/old-repo' }) });
  await loading;
  expect(courses.list).toBeNull();
  expect(courses.loading).toBe(false);
});

test('while entered, a courses or workspace change reloads the list and the pack shown; leaving stops it', async () => {
  const courses = useCoursesStore();
  await courses.loadView();
  await courses.enter(true);
  expect(api.courses.list).toHaveBeenCalledTimes(1);
  api.emitState({ repositoryId: null, domains: ['courses'] });
  await flushPromises();
  expect(api.courses.list).toHaveBeenCalledTimes(2);
  expect(api.courses.preview).toHaveBeenCalledTimes(2);
  api.emitState({ repositoryId: null, domains: ['workspace'] });
  await flushPromises();
  expect(api.courses.list).toHaveBeenCalledTimes(3);
  api.emitState({ repositoryId: null, domains: ['tutor'] });
  courses.leave();
  api.emitState({ repositoryId: null, domains: ['courses'] });
  await flushPromises();
  expect(api.courses.list).toHaveBeenCalledTimes(3);
});

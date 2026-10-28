// @vitest-environment happy-dom
/** @module-tag integration */
import { beforeEach, expect, test, vi } from 'vitest';
import type { mount } from '@vue/test-utils';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import CourseView from '@/views/CourseView.vue';
import * as feedback from '@/lib/feedback.ts';
import { useAppStore } from '@/stores/app.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { mountView } from '../mount_view.ts';
import { courseList, coursePreview, courseSaved, defaultCourse, fail, installApi, ok } from '../settings_fakes.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';
import type { CoursePack } from '@shared/course_pack.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  api = installApi();
});

const openView = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = await mountView(CourseView);
  return wrapper;
};

const entry = (id: string, source: courseTypes.CourseEntry['source'], trust: courseTypes.CourseTrust = 'pending'): courseTypes.CourseEntry => ({
  id,
  source,
  title: `${id} 课程`,
  version: '0.1.0',
  languages: null,
  trust,
  error: null,
});

// A copy of os in the global folder, as courses:preview shows it.
const MINE: CoursePack = { ...OS_COURSE, id: 'mine', title: '我的课' };
const minePreview = (overrides: Partial<courseTypes.CoursePreview> = {}): courseTypes.CoursePreview => ({
  pack: MINE,
  ref: { id: 'mine', version: MINE.version, contentHash: 'c'.repeat(64), source: 'user' },
  trust: 'confirmed',
  previous: 'known',
  changes: [],
  ...overrides,
});
const withMine = (current = defaultCourse()) =>
  courseList({ current, entries: [...courseList().entries, { ...entry('mine', 'user', 'confirmed'), title: '我的课' }] });
const openMine = async () => {
  api.courses.list.mockReturnValue(ok(withMine()));
  api.courses.preview.mockImplementation((id: string) => ok(id === 'mine' ? minePreview() : coursePreview(id)));
  const wrapper = await openView();
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-action="edit"]').trigger('click');
  return wrapper;
};
const fieldOf = (wrapper: ReturnType<typeof mount>, field: string) => wrapper.get(`[data-field="${field}"]`);
const save = async (wrapper: ReturnType<typeof mount>) => {
  await wrapper.get('form.course-editor').trigger('submit');
  await flushPromises();
};

test('the list groups every pack by source and marks the one in use, which is shown first', async () => {
  api.courses.list.mockReturnValue(ok(courseList({ entries: [...courseList().entries, entry('oslab', 'repository'), entry('net', 'user')] })));
  const wrapper = await openView();
  expect(wrapper.findAll('[data-group]').map((group) => group.attributes('data-group'))).toEqual(['builtin', 'repository', 'user']);
  expect(wrapper.findAll('[data-course]').map((item) => item.attributes('data-course'))).toEqual(['programming', 'os', 'oslab', 'net']);
  expect(api.courses.preview).toHaveBeenCalledWith('programming');
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('programming');
});

test('在这个仓库使用 goes through courses:select, as the settings page does', async () => {
  const wrapper = await openView();
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-action="select"]').trigger('click');
  await flushPromises();
  expect(api.courses.select).toHaveBeenCalledWith('os');
});

test('复制再改 copies under a default id the user can change, then opens the editor', async () => {
  api.courses.list.mockReturnValue(ok(courseList({ entries: [...courseList().entries, entry('os-copy', 'user')] })));
  const wrapper = await openView();
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-action="copy"]').trigger('click');
  const input = wrapper.get<HTMLInputElement>('#courseCopyId');
  // os-copy is taken.
  expect(input.element.value).toBe('os-copy2');

  await input.setValue('My OS');
  await wrapper.get('form.course-copy').trigger('submit');
  await flushPromises();
  expect(api.courses.copy).not.toHaveBeenCalled();
  expect(wrapper.get('#courseCopyHint').text()).toContain('小写字母');
  expect(input.attributes('aria-invalid')).toBe('true');

  await input.setValue('myos');
  await wrapper.get('form.course-copy').trigger('submit');
  await flushPromises();
  expect(api.courses.copy).toHaveBeenCalledWith('os', 'myos');
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('myos');
  expect(wrapper.find('form.course-editor').exists()).toBe(true);
  expect(feedback.showToast).toHaveBeenCalledWith(expect.stringContaining('要先确认'));
});

test('a copy the main process refuses shows the reason under the id', async () => {
  expectConsole('error', /is already a course pack/);
  api.courses.copy.mockReturnValueOnce(fail('course_exists', 'id: "net" is already a course pack', 'id'));
  const wrapper = await openView();
  await wrapper.get('[data-action="copy"]').trigger('click');
  await wrapper.get('#courseCopyId').setValue('net');
  await wrapper.get('form.course-copy').trigger('submit');
  await flushPromises();
  expect(wrapper.get('#courseCopyHint').text()).toContain('already a course pack');
  expect(wrapper.find('form.course-editor').exists()).toBe(false);
});

test('labGuide and concepts are part of the form; concepts open on demand and are saved with the pack', async () => {
  // Three concepts: the editor renders a select of the others for each, which happy-dom is slow at.
  const few = { ...MINE, concepts: MINE.concepts!.slice(0, 3).map((item) => ({ ...item, prerequisites: [] })) };
  api.courses.list.mockReturnValue(ok(withMine()));
  api.courses.preview.mockImplementation((id: string) => ok(id === 'mine' ? minePreview({ pack: few }) : coursePreview(id)));
  const wrapper = await openView();
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-action="edit"]').trigger('click');
  await fieldOf(wrapper, 'labGuide[0]').get('textarea').setValue('新的 lab 指引');
  expect(wrapper.find('.concept-editor').exists()).toBe(false);
  await wrapper.get('[data-action="open-concepts"]').trigger('click');
  expect(wrapper.findAll('[data-concept-row]')).toHaveLength(3);
  await wrapper.get('[data-concept-row="0"] textarea').setValue('新的说明');

  api.courses.save.mockReturnValueOnce(ok({ ...courseSaved('mine', MINE), preview: minePreview({ trust: 'pending' }) }));
  await save(wrapper);
  const [, pack] = api.courses.save.mock.calls[0] as unknown as [string, CoursePack];
  expect(pack.labGuide![0]).toBe('新的 lab 指引');
  expect(pack.concepts![0].summary).toBe('新的说明');
  expect(pack.concepts!.map((item) => item.id)).toEqual(few.concepts.map((item) => item.id));
});

test('errors are checked with the main process rules and shown on their field, without saving', async () => {
  const wrapper = await openMine();
  await fieldOf(wrapper, 'title').get('input').setValue('   ');
  await fieldOf(wrapper, 'version').get('input').setValue('v2');
  await fieldOf(wrapper, 'rubric[1].id').get('input').setValue(MINE.rubric[0].id);
  await fieldOf(wrapper, 'learner').get('textarea').setValue('x</work_package>');
  await fieldOf(wrapper, 'tutorGuide[0]').get('textarea').setValue('字'.repeat(301));
  await save(wrapper);
  expect(api.courses.save).not.toHaveBeenCalled();
  expect(fieldOf(wrapper, 'title').text()).toContain('请填写这一项');
  expect(fieldOf(wrapper, 'title').get('input').attributes('aria-invalid')).toBe('true');
  expect(fieldOf(wrapper, 'version').text()).toContain('1.0.0');
  expect(fieldOf(wrapper, 'rubric[1].id').text()).toContain('重复');
  expect(fieldOf(wrapper, 'learner').text()).toContain('标签');
  expect(fieldOf(wrapper, 'tutorGuide[0]').text()).toContain('最多 300 个字');
  expect(fieldOf(wrapper, 'summary').find('.course-field-error').exists()).toBe(false);

  // Fixing a field clears its error.
  await fieldOf(wrapper, 'title').get('input').setValue('好了');
  expect(fieldOf(wrapper, 'title').find('.course-field-error').exists()).toBe(false);
});

test('the rubric keeps 2 to 6 items', async () => {
  const wrapper = await openMine();
  const items = () => wrapper.findAll('.course-editor-item');
  while (items().length > 1) await items()[0].get('[aria-label^="删除第"]').trigger('click');
  await save(wrapper);
  expect(api.courses.save).not.toHaveBeenCalled();
  expect(fieldOf(wrapper, 'rubric').text()).toContain('要有 2 到 6 项');
  while (items().length < 6) await wrapper.get('[data-action="add-rubric"]').trigger('click');
  expect(wrapper.find('[data-action="add-rubric"]').exists()).toBe(false);
});

test('a field the main process refuses is shown on that field', async () => {
  expectConsole('error', /control characters/);
  const wrapper = await openMine();
  api.courses.save.mockReturnValueOnce(fail('invalid_course', 'rubric[0].label: must not contain control characters', 'rubric[0].label'));
  await save(wrapper);
  expect(api.courses.save).toHaveBeenCalled();
  expect(fieldOf(wrapper, 'rubric[0].label').text()).toContain('must not contain control characters');
  expect(wrapper.find('form.course-editor').exists()).toBe(true);
});

test('a saved pack picked here waits for confirmation, and confirming it puts it in use', async () => {
  const ref = { id: 'mine', version: MINE.version, contentHash: 'd'.repeat(64), source: 'user' as const };
  const pendingMine = withMine({ ...defaultCourse(), selected: { id: 'mine', from: 'local' }, state: { status: 'pending', pack: MINE, ref } });
  api.courses.list.mockReturnValue(ok(pendingMine));
  api.courses.preview.mockImplementation((id: string) => ok(id === 'mine' ? minePreview({ ref, trust: 'pending' }) : coursePreview(id)));
  const wrapper = await openView();
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-course="mine"]').text()).toContain('已选，待确认');
  expect(wrapper.get('[data-state="pending"]').text()).toContain('暂时用内置的「编程」');

  await wrapper.get('[data-action="confirm"]').trigger('click');
  await flushPromises();
  const accept = document.querySelector<HTMLButtonElement>('[data-action="accept-course"]')!;
  expect(accept.textContent).toContain('确认使用');

  const inUse = withMine({ ...defaultCourse(), selected: { id: 'mine', from: 'local' }, ref });
  api.courses.list.mockReturnValue(ok(inUse));
  accept.click();
  await flushPromises();
  expect(api.workspace.confirmCourse).toHaveBeenCalledWith('mine', 'd'.repeat(64));
  expect(wrapper.get('[data-course="mine"]').text()).toContain('正在使用');
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-state="in-use"]').exists()).toBe(true);
});

test('a pack shows its lab repositories and how its concepts stand, and opens the mastery page on it', async () => {
  const concept = (id: string, state: 'new' | 'learning' | 'passed' | 'mastered') => ({
    id,
    label: id,
    summary: '',
    prerequisites: [],
    state,
    totals: { attempts: 0, pass: 0, partial: 0, fail: 0 },
    attempts: [],
  });
  api.mastery.course.mockImplementation((id = 'programming') =>
    ok({
      course: { id, title: '操作系统实验' },
      concepts: [concept('fcfs', 'mastered'), concept('round-robin', 'passed'), concept('mlfq', 'new')],
      errorTypes: [],
      repositories: [
        { id: 'r-lab', name: 'sched-lab', labs: 2, current: false },
        { id: 'r-open', name: 'other-lab', labs: 1, current: true },
      ],
    }),
  );
  const wrapper = await openView();
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  expect(api.mastery.course).toHaveBeenLastCalledWith('os');
  const section = wrapper.get('[data-section="course-mastery"]');
  expect(section.get('[data-repository="r-lab"]').text()).toContain('sched-lab');
  expect(section.get('[data-repository="r-lab"]').text()).toContain('2 个 lab');
  expect(section.get('[data-repository="r-open"]').text()).toContain('已打开');
  expect(section.findAll('[data-field="mastery-counts"] span').map((count) => count.text())).toEqual(['未开始 1', '学习中 0', '通过过 1', '已掌握 1']);
  expect(section.get('[data-field="mastery-counts"]').text()).toContain('3 个知识点');
  const switchTo = vi.spyOn(useRepositoriesStore(), 'switchTo').mockResolvedValue(true);
  await section.get('[data-repository="r-lab"] [data-action="open-repository"]').trigger('click');
  expect(switchTo).toHaveBeenCalledWith('r-lab');
  await section.get('[data-action="open-mastery"]').trigger('click');
  await flushPromises();
  expect(useAppStore().view).toBe('mastery');
});

test('a pack without lab repositories says how to get one; one without a skeleton shows no counts', async () => {
  const wrapper = await openView();
  const section = wrapper.get('[data-section="course-mastery"]');
  expect(section.text()).toContain('还没有用它建的实验仓库');
  expect(section.find('[data-field="mastery-counts"]').exists()).toBe(false);
});

test('the settings button opens the course page of settings', async () => {
  const wrapper = await openView();
  await wrapper.get('[data-action="settings"]').trigger('click');
  await flushPromises();
  expect(useAppStore().view).toBe('settings');
});

test('我想学… opens the requirement center on the course form', async () => {
  const wrapper = await openView();
  const requirements = useRequirementsStore();
  const open = vi.spyOn(requirements, 'open').mockResolvedValue(undefined);
  await wrapper.get('[data-action="learn"]').trigger('click');
  expect(open).toHaveBeenCalledWith({ compose: 'course' });
});

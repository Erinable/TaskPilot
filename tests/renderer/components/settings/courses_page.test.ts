// @vitest-environment happy-dom
/** @module-tag integration */
import { beforeEach, expect, test, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import SettingsView from '@/views/SettingsView.vue';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { mountView } from '../../mount_view.ts';
import { courseList, coursePreview, defaultCourse, installApi, ok } from '../../settings_fakes.ts';
import { OS_COURSE } from '../../../fixtures/builtin_courses.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi();
});

const mountPage = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = await mountView(SettingsView);
  await useSettingsStore().open('courses');
  await flushPromises();
  return wrapper;
};

const dialog = () => document.querySelector<HTMLElement>('.course-preview-dialog');
const acceptButton = () => document.querySelector<HTMLButtonElement>('[data-action="accept-course"]');

const oslab = (): courseTypes.CourseEntry => ({
  id: 'oslab',
  source: 'repository',
  title: '操作系统实验',
  version: '0.1.0',
  languages: null,
  trust: 'pending',
  error: null,
});
const pending = () => {
  const ref = { id: 'oslab', version: '0.1.0', contentHash: 'b'.repeat(64), source: 'repository' as const };
  return courseList({
    current: { ...defaultCourse(), selected: { id: 'oslab', from: 'project' }, state: { status: 'pending', pack: { ...OS_COURSE, id: 'oslab' }, ref } },
    entries: [...courseList().entries, oslab()],
  });
};

test('the page shows the pack in use and where the choice came from, and links to the course view', async () => {
  const wrapper = await mountPage();
  expect(api.courses.list).toHaveBeenCalled();
  expect(wrapper.get('#courseState').text()).toContain('正在使用：编程');
  expect(wrapper.get('#courseState').text()).toContain('选择来自默认');
  // Built-in packs need no confirmation, and browsing them is the course view.
  expect(wrapper.findAll('#pendingCourses [data-course]')).toHaveLength(0);
  expect(wrapper.find('[data-empty="pending"]').exists()).toBe(true);
  expect(wrapper.find('#courseLanguageWarning').exists()).toBe(false);
  await wrapper.get('#openCourseView').trigger('click');
  await flushPromises();
  expect(useAppStore().view).toBe('courses');
});

test('picking a pack for another language warns about the mismatch', async () => {
  api.courses.list.mockReturnValue(
    ok(courseList({ current: { ...defaultCourse(), selected: { id: 'os', from: 'local' }, ref: { ...defaultCourse().ref, id: 'os' } } })),
  );
  const wrapper = await mountPage();
  expect(wrapper.get('#courseLanguageWarning').text()).toContain('c, rust');
  expect(wrapper.find('#clearCourse').exists()).toBe(true);
});

test('a pack waiting for confirmation is listed; 选用并确认 writes the choice through courses:select', async () => {
  const imported = { ...oslab(), id: 'net', source: 'user' as const, title: '网络实验' };
  api.courses.list.mockReturnValue(ok(courseList({ entries: [...courseList().entries, imported] })));
  const wrapper = await mountPage();
  expect(wrapper.findAll('#pendingCourses [data-course]').map((row) => row.attributes('data-course'))).toEqual(['net']);
  await wrapper.get('[data-course="net"] [data-action="select"]').trigger('click');
  await flushPromises();
  expect(api.courses.select).toHaveBeenCalledWith('net');
});

test('a pending pack is confirmed from a preview of its whole content', async () => {
  api.courses.list.mockReturnValue(ok(pending()));
  api.courses.preview.mockReturnValue(ok(coursePreview('oslab', { pack: { ...OS_COURSE, id: 'oslab' } })));
  const wrapper = await mountPage();
  expect(wrapper.get('#courseState').text()).toContain('课程包待确认');
  await wrapper.get('#confirmCourse').trigger('click');
  await flushPromises();
  const text = dialog()!.textContent!;
  for (const line of [...OS_COURSE.tutorGuide, ...OS_COURSE.difficultyGuide, ...OS_COURSE.practiceGuide, OS_COURSE.referenceGuide, OS_COURSE.learner])
    expect(text).toContain(line);
  for (const item of OS_COURSE.rubric) expect(text).toContain(item.description);
  for (const line of OS_COURSE.labGuide!) expect(text).toContain(line);
  for (const item of OS_COURSE.concepts!) expect(text).toContain(item.summary);
  expect(document.querySelector('[data-concept="round-robin"]')!.textContent).toContain('前置：先来先服务（FCFS）、时钟中断与抢占');
  expect(text).toContain('.taskpilot/courses/oslab.toml');
  acceptButton()!.click();
  await flushPromises();
  expect(api.workspace.confirmCourse).toHaveBeenCalledWith('oslab', 'b'.repeat(64));
});

test('a changed pack lists and marks what changed, and needs the changes ticked before confirming', async () => {
  api.courses.list.mockReturnValue(ok(pending()));
  const changes = [
    { field: 'tutorGuide', kind: 'changed' as const },
    { field: 'rubric.concept.description', kind: 'changed' as const },
    { field: 'concepts.mlfq.prerequisites', kind: 'changed' as const },
  ];
  api.courses.preview.mockReturnValue(ok(coursePreview('oslab', { pack: { ...OS_COURSE, id: 'oslab' }, previous: 'known', changes })));
  const wrapper = await mountPage();
  await wrapper.get('#confirmCourse').trigger('click');
  await flushPromises();
  const listed = [...document.querySelectorAll('#courseChanges li')].map((item) => item.textContent);
  expect(listed).toEqual(['修改 讲解指引', '修改 判卷维度 concept 的说明', '修改 知识点 mlfq 的前置知识点']);
  expect(document.querySelector('[data-concept="mlfq"]')!.classList.contains('changed')).toBe(true);
  expect(document.querySelector('[data-concept="fcfs"]')!.classList.contains('changed')).toBe(false);
  expect(document.querySelector('[data-rubric="concept"]')!.classList.contains('changed')).toBe(true);
  expect(document.querySelector('[data-rubric="mechanism"]')!.classList.contains('changed')).toBe(false);
  expect(acceptButton()!.disabled).toBe(true);
  const tick = document.querySelector<HTMLInputElement>('#courseChangesRead')!;
  tick.checked = true;
  tick.dispatchEvent(new Event('change'));
  await flushPromises();
  expect(acceptButton()!.disabled).toBe(false);
});

test('a preview of a pending pack that is not picked only shows it', async () => {
  const imported = { ...oslab(), id: 'net', source: 'user' as const, title: '网络实验' };
  api.courses.list.mockReturnValue(ok(courseList({ entries: [...courseList().entries, imported] })));
  api.courses.preview.mockReturnValue(ok(coursePreview('net')));
  const wrapper = await mountPage();
  await wrapper.get('[data-course="net"] [data-action="preview"]').trigger('click');
  await flushPromises();
  expect(dialog()!.textContent).toContain(OS_COURSE.summary);
  expect(acceptButton()).toBeNull();
});

test('importing shows the picked file before copying it', async () => {
  api.courses.pickImport.mockReturnValue(
    ok({ ...coursePreview('net'), ref: { ...coursePreview('net').ref, source: 'user' }, replaces: true, shadowed: false }),
  );
  const wrapper = await mountPage();
  expect(wrapper.get('#courseUserDir').text()).toBe('/config/courses');
  await wrapper.get('#importCourse').trigger('click');
  await flushPromises();
  expect(dialog()!.textContent).toContain('导入会替换它');
  expect(api.courses.import).not.toHaveBeenCalled();
  acceptButton()!.click();
  await flushPromises();
  expect(api.courses.import).toHaveBeenCalledWith('b'.repeat(64));
});

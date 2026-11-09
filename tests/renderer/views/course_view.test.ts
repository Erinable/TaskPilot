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
import { useCoursesStore } from '@/stores/courses.ts';
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

const openView = async (repositoryId: string | null = 'repo-open') => {
  const pinia = createPinia();
  setActivePinia(pinia);
  useRepositoriesStore().currentId = repositoryId;
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

test('the default overview presents course facts while the complete original instructions stay in a closed disclosure', async () => {
  const wrapper = await openView();
  const pack = coursePreview('programming').pack;
  const overview = wrapper.get('[data-section="course-overview"]');
  expect(overview.get('[aria-label="课程简介"]').text()).toContain(pack.summary);
  expect(overview.get('[aria-label="适合谁"]').text()).toContain('学习编程的开发者');
  expect(overview.get('[aria-label="适合谁"]').text()).not.toContain(pack.learner);
  expect(overview.get('[aria-label="练习内容"]').text()).toContain('未列出固定知识点');
  expect(
    overview
      .get('[aria-label="如何判卷"]')
      .findAll('dt')
      .map((item) => item.text()),
  ).toEqual(pack.rubric.map((item) => item.label));
  expect(overview.text()).not.toContain(pack.difficultyGuide[0]);
  for (const item of pack.rubric) expect(overview.get('[aria-label="如何判卷"]').text()).not.toContain(item.description);
  const details = wrapper.get<HTMLDetailsElement>('[data-section="course-instructions"]');
  expect(details.element.open).toBe(false);
  expect(details.get('summary').text()).toBe('完整课程指令');
  for (const guide of [
    ...pack.tutorGuide,
    ...pack.difficultyGuide,
    ...pack.practiceGuide,
    pack.referenceGuide,
    pack.learner,
    ...pack.rubric.map((item) => item.description),
  ]) {
    expect(details.get('.course-fields').element.textContent).toContain(guide);
  }
});

test('the built-in operating systems overview uses Chinese descriptions while preserving the full original pack', async () => {
  const wrapper = await openView();
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  const overview = wrapper.get('[data-section="course-overview"]');
  expect(overview.get('[aria-label="适合谁"]').text()).toContain('基础 C 语言');
  expect(overview.get('[aria-label="如何判卷"]').text()).toContain('内核态');
  expect(overview.get('[aria-label="如何判卷"]').text()).toContain('分配失败');
  expect(overview.get('[aria-label="如何判卷"]').text()).toContain('竞争条件');
  const original = wrapper.get('[data-section="course-instructions"] .course-fields').element.textContent;
  expect(original).toContain(OS_COURSE.learner);
  for (const item of OS_COURSE.rubric) {
    expect(overview.text()).not.toContain(item.description);
    expect(original).toContain(item.description);
  }
});

test('custom course wording and every concept remain exact in the full instructions without expanding them in the overview', async () => {
  const pack: CoursePack = {
    ...MINE,
    summary: '自定义简介，保持原文。',
    learner: 'Custom learners: keep THIS exact wording.',
    tutorGuide: ['Original tutor instruction — unchanged.'],
    concepts: MINE.concepts!.slice(0, 5),
  };
  api.courses.list.mockReturnValue(ok(withMine()));
  api.courses.preview.mockImplementation((id: string) => ok(id === 'mine' ? minePreview({ pack }) : coursePreview(id)));
  const wrapper = await openView();
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  const overview = wrapper.get('[data-section="course-overview"]');
  expect(overview.get('[aria-label="课程简介"] p').element.textContent).toBe(pack.summary);
  expect(overview.get('[aria-label="适合谁"] p').element.textContent).toBe(pack.learner);
  expect(overview.findAll('.course-overview-concepts li')).toHaveLength(4);
  expect(overview.text()).toContain('包含 5 个知识点');
  expect(overview.text()).not.toContain(pack.concepts![4].summary);
  expect(overview.text()).not.toContain(pack.tutorGuide[0]);
  const instructions = wrapper.get('[data-section="course-instructions"] .course-fields');
  expect(instructions.element.textContent).toContain(pack.tutorGuide[0]);
  for (const concept of pack.concepts!) expect(instructions.get(`[data-concept="${concept.id}"]`).text()).toContain(concept.summary);
  for (const item of pack.rubric) expect(overview.get('[aria-label="如何判卷"]').element.textContent).toContain(item.description);
});

test('without an open repository the default pack is labeled honestly and repository selection or mismatch statuses stay hidden', async () => {
  const wrapper = await openView(null);
  expect(wrapper.get('[data-course="programming"]').text()).toContain('默认课程');
  expect(wrapper.get('[data-state="no-repository"]').text()).toContain('这是内置默认课程');
  expect(wrapper.find('[data-state="in-use"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('正在使用');
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-state="no-repository"]').text()).toContain('打开仓库后再选择使用');
  expect(wrapper.find('[data-action="select"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('这个仓库正在用它');
  expect(wrapper.text()).not.toContain('和仓库语言不匹配');
  expect(api.courses.select).not.toHaveBeenCalled();
});

test('an unassigned pending choice does not appear as a repository selection or enable repository confirmation', async () => {
  const ref = minePreview().ref;
  api.courses.list.mockReturnValue(
    ok(withMine({ ...defaultCourse(), selected: { id: 'mine', from: 'local' }, state: { status: 'pending', pack: MINE, ref } })),
  );
  api.courses.preview.mockImplementation((id: string) => ok(id === 'mine' ? minePreview({ trust: 'pending' }) : coursePreview(id)));
  const wrapper = await openView(null);
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-state="no-repository"]').text()).toContain('未打开仓库');
  expect(wrapper.find('[data-state="pending"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="confirm"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="select"]').exists()).toBe(false);
  expect(wrapper.get('[data-course="mine"]').text()).not.toContain('已选，待确认');
  expect(wrapper.get('[data-course="programming"]').text()).toContain('默认课程');
});

test('switching courses, leaving the view and switching repositories retain the full user draft until explicit cancel', async () => {
  let wrapper = await openMine();
  await fieldOf(wrapper, 'title').get('input').setValue('未保存的标题');
  await fieldOf(wrapper, 'labGuide[0]').get('textarea').setValue('未保存的实验指引');
  expect(wrapper.get('[data-field="draft-status"]').text()).toContain('草稿会保留');
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('form.course-editor').exists()).toBe(false);
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(fieldOf(wrapper, 'title').get<HTMLInputElement>('input').element.value).toBe('未保存的标题');
  wrapper.unmount();
  // Repository switches reset repository data while global user packs keep their drafts.
  useCoursesStore().reset();
  wrapper = await mountView(CourseView);
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(fieldOf(wrapper, 'labGuide[0]').get<HTMLTextAreaElement>('textarea').element.value).toBe('未保存的实验指引');
  await wrapper.get('.course-editor-actions .secondary-button').trigger('click');
  await wrapper.get('[data-action="edit"]').trigger('click');
  expect(fieldOf(wrapper, 'title').get<HTMLInputElement>('input').element.value).toBe(MINE.title);
});

test('a delayed save preserves edits made after its snapshot and does not reopen its course after a switch', async () => {
  const wrapper = await openMine();
  await fieldOf(wrapper, 'title').get('input').setValue('提交的标题');
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.save>>>();
  api.courses.save.mockReturnValueOnce(held.promise);
  await wrapper.get('form.course-editor').trigger('submit');
  await fieldOf(wrapper, 'title').get('input').setValue('提交后继续写');
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  held.resolve({ ok: true, data: { list: withMine(), preview: minePreview({ pack: { ...MINE, title: '提交的标题' } }) } });
  await flushPromises();
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('os');
  await wrapper.get('[data-course="mine"]').trigger('click');
  await flushPromises();
  expect(fieldOf(wrapper, 'title').get<HTMLInputElement>('input').element.value).toBe('提交后继续写');
});

test('initial list and preview failures show persistent retry actions instead of indefinite loading', async () => {
  expectConsole('error', /read failed/);
  api.courses.list.mockReturnValueOnce(fail('unknown', 'read failed'));
  const wrapper = await openView();
  expect(wrapper.get('[data-error="courses-load"]').text()).toContain('read failed');
  expect(wrapper.find('[data-loading]').exists()).toBe(false);
  api.courses.preview.mockReturnValueOnce(fail('unknown', 'read failed'));
  await wrapper.get('[data-action="retry-courses"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-error="courses-load"]').exists()).toBe(false);
  expect(wrapper.get('[data-error="course-preview"]').text()).toContain('read failed');
  await wrapper.get('[data-action="retry-preview"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-error="course-preview"]').exists()).toBe(false);
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('programming');
});

test('a failed save retains the editor and its draft with an inline recovery message', async () => {
  expectConsole('error', /read-only disk/);
  const wrapper = await openMine();
  await fieldOf(wrapper, 'title').get('input').setValue('保留的输入');
  api.courses.save.mockReturnValueOnce(fail('unknown', 'read-only disk'));
  await save(wrapper);
  expect(wrapper.get('form.course-editor').text()).toContain('read-only disk');
  expect(fieldOf(wrapper, 'title').get<HTMLInputElement>('input').element.value).toBe('保留的输入');
});

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

test('a long invalid form focuses its first field after rendering and keeps a linked error count beside save until corrected', async () => {
  const wrapper = await openMine();
  const title = fieldOf(wrapper, 'title');
  const version = fieldOf(wrapper, 'version');
  const titleScroll = vi.spyOn(title.element, 'scrollIntoView').mockImplementation(() => {
    expect(title.get('input').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('[data-error="save-summary"]').text()).toContain('2 项');
  });
  const versionScroll = vi.spyOn(version.element, 'scrollIntoView');
  await title.get('input').setValue('');
  await version.get('input').setValue('v2');
  wrapper.get<HTMLButtonElement>('[data-action="save-course"]').element.focus();
  await save(wrapper);
  expect(api.courses.save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(title.get('input').element);
  expect(titleScroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  expect(wrapper.get('[data-error="save-summary"]').findAll('button')).toHaveLength(2);
  await wrapper.get('[data-error-field="version"]').trigger('click');
  expect(document.activeElement).toBe(version.get('input').element);
  expect(versionScroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  await title.get('input').setValue('已修正的名称');
  expect(wrapper.get('[data-error="save-summary"]').text()).toContain('1 项');
  expect(useCoursesStore().drafts['user:mine'].title).toBe('已修正的名称');
  await version.get('input').setValue('2.0.0');
  expect(wrapper.find('[data-error="save-summary"]').exists()).toBe(false);
  api.courses.save.mockReturnValueOnce(ok({ list: withMine(), preview: minePreview({ pack: { ...MINE, title: '已修正的名称', version: '2.0.0' } }) }));
  await save(wrapper);
  expect(api.courses.save).toHaveBeenCalledWith('mine', expect.objectContaining({ title: '已修正的名称', version: '2.0.0' }));
  expect(wrapper.find('form.course-editor').exists()).toBe(false);
  expect(useCoursesStore().drafts['user:mine']).toBeUndefined();
});

test('invalid save opens collapsed concepts and links internal errors to the correct native control', async () => {
  const wrapper = await openMine();
  useCoursesStore().drafts['user:mine'].concepts = [
    { id: 'first', label: '第一个', summary: '说明', prerequisites: [] },
    { id: 'second', label: '', summary: '', prerequisites: [] },
  ];
  expect(wrapper.find('.concept-editor').exists()).toBe(false);
  await save(wrapper);
  expect(api.courses.save).not.toHaveBeenCalled();
  const row = wrapper.get('[data-concept-row="1"]');
  expect(document.activeElement).toBe(row.get('input[aria-label="知识点名称"]').element);
  expect(wrapper.get('[data-error="save-summary"]').text()).toContain('2 项');
  await wrapper.get('[data-error-field="concepts[1].summary"]').trigger('click');
  expect(document.activeElement).toBe(row.get('textarea[aria-label="知识点说明"]').element);
  expect(useCoursesStore().drafts['user:mine'].concepts[1].label).toBe('');
});

test('server concept field errors expand the collapsed section, retain the draft and provide the same focus recovery', async () => {
  expectConsole('error', /server concept refusal/);
  const wrapper = await openMine();
  useCoursesStore().drafts['user:mine'].concepts = [{ id: 'first', label: '名称', summary: '说明', prerequisites: [] }];
  api.courses.save.mockReturnValueOnce(fail('invalid_course', 'server concept refusal', 'concepts[0].summary'));
  await save(wrapper);
  expect(wrapper.get('[data-error="save-summary"]').text()).toContain('1 项');
  expect(wrapper.get('[data-error-field="concepts[0].summary"]').text()).toContain('server concept refusal');
  expect(document.activeElement).toBe(wrapper.get('[data-concept-row="0"] textarea').element);
  expect(useCoursesStore().drafts['user:mine'].concepts[0].summary).toBe('说明');
  await wrapper.get('[data-concept-row="0"] textarea').setValue('修正说明');
  expect(wrapper.find('[data-error="save-summary"]').exists()).toBe(false);
});

test('copy-and-edit stays on the copied editor when a pending refresh preview returns', async () => {
  const wrapper = await openView();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.preview>>>();
  api.courses.preview.mockReturnValueOnce(held.promise);
  const refreshing = useCoursesStore().loadView();
  await flushPromises();
  await wrapper.get('[data-action="copy"]').trigger('click');
  await wrapper.get('#courseCopyId').setValue('my-copy');
  await wrapper.get('form.course-copy').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('my-copy');
  await fieldOf(wrapper, 'title').get('input').setValue('副本草稿');
  held.resolve({ ok: true, data: coursePreview('programming') });
  await refreshing;
  await flushPromises();
  expect(useCoursesStore().viewedId).toBe('my-copy');
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('my-copy');
  expect(wrapper.get('[data-course="my-copy"]').attributes('aria-current')).toBe('true');
  expect(fieldOf(wrapper, 'title').get<HTMLInputElement>('input').element.value).toBe('副本草稿');
});

test('copy form guards keyboard resubmission and does not open an editor after selecting another course', async () => {
  const wrapper = await openView();
  await wrapper.get('[data-action="copy"]').trigger('click');
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.courses.copy>>>();
  api.courses.copy.mockReturnValueOnce(held.promise);
  await wrapper.get('form.course-copy').trigger('submit');
  expect(wrapper.get('[data-action="copy-submit"]').attributes('aria-busy')).toBe('true');
  await wrapper.get('form.course-copy').trigger('submit');
  expect(api.courses.copy).toHaveBeenCalledTimes(1);
  await wrapper.get('[data-course="os"]').trigger('click');
  await flushPromises();
  held.resolve({ ok: true, data: courseSaved('programming-copy') });
  await flushPromises();
  expect(wrapper.get('[data-detail]').attributes('data-detail')).toBe('os');
  expect(wrapper.find('form.course-editor').exists()).toBe(false);
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
  expect(document.activeElement).toBe(fieldOf(wrapper, 'rubric[0].label').get('input').element);
  expect(wrapper.get('[data-error="save-summary"]').text()).toContain('1 项');
  expect(wrapper.get('[data-error-field="rubric[0].label"]').text()).toContain('must not contain control characters');
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
  const fullContent = document.querySelector('.course-preview-dialog .course-fields')!;
  expect(fullContent.closest('details')).toBeNull();
  expect(fullContent.textContent).toContain(MINE.learner);
  for (const guide of [...MINE.tutorGuide, ...MINE.difficultyGuide, ...MINE.practiceGuide, ...MINE.labGuide!, MINE.referenceGuide]) {
    expect(fullContent.textContent).toContain(guide);
  }
  expect(fullContent.querySelectorAll('[data-concept]')).toHaveLength(MINE.concepts!.length);
  expect(fullContent.querySelectorAll('[data-rubric]')).toHaveLength(MINE.rubric.length);

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

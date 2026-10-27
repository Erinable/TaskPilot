// @vitest-environment happy-dom
// 掌握度 (views/MasteryView.vue): the concept graph coloured by state, the
// notes due today with the learner's verdict, the top error types, and one
// concept's attempts, notes, labs and project tasks. Walks the CARM-33
// example after its first lab: round-robin passed once, its note due.
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import MasteryView from '@/views/MasteryView.vue';
import { conceptGraph, conceptLinks, stateCounts } from '@/lib/mastery_model.ts';
import { useAppStore } from '@/stores/app.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useMasteryStore } from '@/stores/mastery.ts';
import { useNotesStore } from '@/stores/notes.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import * as feedback from '@/lib/feedback.ts';
import { courseList, installApi, ok } from '../settings_fakes.ts';
import { taskView } from '../execution_fakes.ts';
import type * as masteryTypes from '@shared/ipc/mastery.ts';
import type * as noteTypes from '@shared/ipc/notes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));
// Mermaid needs a real layout engine; the graph's source is what is checked.
vi.mock('@/components/notes/NoteChart.vue', () => ({
  default: { name: 'NoteChart', props: ['lang', 'source'], template: '<pre data-chart :data-lang="lang">{{ source }}</pre>' },
}));

let api: ReturnType<typeof installApi> & { mastery: Record<string, ReturnType<typeof vi.fn>>; notes: Record<string, ReturnType<typeof vi.fn>> };

const concept = (id: string, label: string, prerequisites: string[], state: masteryTypes.ConceptState, attempts: masteryTypes.ConceptAttempt[] = []) => ({
  id,
  label,
  summary: `${label}的要点。`,
  prerequisites,
  state,
  totals: {
    attempts: attempts.length,
    pass: attempts.filter((entry) => entry.result === 'pass').length,
    partial: 0,
    fail: attempts.filter((entry) => entry.result === 'fail').length,
  },
  attempts,
});

const RR_ATTEMPTS: masteryTypes.ConceptAttempt[] = [
  { at: '2026-10-27T03:00:00.000Z', packageId: 'lab-round-robin', repoId: 'lab-repo', result: 'pass', independence: 95 },
  { at: '2026-10-27T02:00:00.000Z', packageId: 'lab-round-robin', repoId: 'lab-repo', result: 'fail', independence: 95 },
];

const OS_MASTERY: masteryTypes.CourseMastery = {
  course: { id: 'os', title: '操作系统实验' },
  concepts: [
    concept('fcfs', '先来先服务', [], 'new'),
    concept('round-robin', '时间片轮转（RR）', ['fcfs'], 'passed', RR_ATTEMPTS),
    concept('priority-sched', '优先级调度', ['round-robin'], 'new'),
  ],
  errorTypes: [{ type: 'missed-edge-case', count: 2 }],
  repositories: [],
};

const note = (id: string, overrides: Partial<noteTypes.NoteMeta> = {}): noteTypes.NoteMeta => ({
  id,
  title: id.replace(/\.md$/, ''),
  category: 'mechanism',
  course: 'os',
  concepts: [],
  tags: [],
  inlineTags: [],
  source: null,
  summary: null,
  summaryStale: false,
  links: [],
  excerpt: '',
  createdAt: '2026-10-27T03:10:00.000Z',
  updatedAt: '2026-10-27T03:10:00.000Z',
  version: 'v1',
  frontmatterError: false,
  ...overrides,
});

const RR_NOTE = note('RR 入队顺序.md', { concepts: ['round-robin'] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi() as typeof api;
  Object.assign(api, {
    mastery: {
      course: vi.fn((id?: string) => ok(id && id !== 'os' ? { ...OS_MASTERY, course: { id, title: `${id} 课程` }, concepts: [], errorTypes: [] } : OS_MASTERY)),
      reviews: vi.fn(() =>
        ok<masteryTypes.ReviewList>({
          today: '2026-10-28',
          due: [{ noteId: RR_NOTE.id, box: 1, dueDay: '2026-10-28', title: 'RR 入队顺序', concepts: ['round-robin'] }],
          total: 1,
        }),
      ),
      review: vi.fn((noteId: string, remembered: boolean) => ok({ noteId, box: remembered ? 2 : 1, dueDay: remembered ? '2026-10-31' : '2026-10-29' })),
    },
    notes: {
      list: vi.fn(() =>
        ok<noteTypes.NoteList>({
          notes: [RR_NOTE, note('别的.md'), note('编程的.md', { course: null, concepts: ['round-robin'] })],
          revision: 1,
          directory: '/notes',
          custom: false,
          unavailable: null,
          truncated: false,
        }),
      ),
    },
  });
  api.courses.list.mockReturnValue(ok(courseList()));
});

const mountView = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  useTasksStore().tasks = [
    taskView({
      id: 'lab-round-robin',
      title: '时间片轮转调度',
      status: 'done',
      statusLabel: '已完成',
      concepts: ['round-robin'],
      course: { id: 'os', version: '0.2.0', contentHash: 'h', source: 'builtin' },
      lab: { id: 'round-robin', stage: 1, difficulty: 'easy' },
    }),
    taskView({ id: 'r1-wp1', title: '实现 RR 调度器', concepts: ['round-robin'], course: { id: 'os', version: '0.2.0', contentHash: 'h', source: 'builtin' } }),
    taskView({ id: 'r1-wp2', title: '无关任务', concepts: [] }),
  ];
  const wrapper = mount(MasteryView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  await flushPromises();
  return wrapper;
};

test('the graph colours each concept by its state, prerequisites pointing at what needs them', async () => {
  const wrapper = await mountView();
  expect(api.mastery.course).toHaveBeenCalledWith(undefined);
  const source = wrapper.get('[data-chart]').text();
  expect(wrapper.get('[data-chart]').attributes('data-lang')).toBe('mermaid');
  expect(source).toContain('c0["先来先服务"]');
  expect(source).toContain('c0 --> c1');
  expect(source).toContain('c1 --> c2');
  expect(source).toContain('class c1 state_passed');
  expect(source).toContain('class c2 state_new');
  expect(wrapper.findAll('[data-concept]').map((button) => [button.attributes('data-concept'), button.attributes('data-state')])).toEqual([
    ['fcfs', 'new'],
    ['round-robin', 'passed'],
    ['priority-sched', 'new'],
  ]);
});

test('today’s reviews: the note due with its box and concepts, remembered or forgotten', async () => {
  const wrapper = await mountView();
  const due = wrapper.get(`[data-review="${RR_NOTE.id}"]`);
  expect(due.text()).toContain('RR 入队顺序');
  expect(due.text()).toContain('第 1 档 · 时间片轮转（RR）');
  expect(wrapper.get('[data-section="reviews"]').text()).toContain('2026-10-28 · 到期 1 篇');
  api.mastery.reviews.mockReturnValue(ok({ today: '2026-10-28', due: [], total: 1 }));
  await due.get('[data-action="remembered"]').trigger('click');
  await flushPromises();
  expect(api.mastery.review).toHaveBeenCalledWith(RR_NOTE.id, true);
  expect(feedback.showToast).toHaveBeenCalledWith('记住了，下次复习在 2026-10-31。');
  expect(wrapper.find('[data-empty="reviews"]').exists()).toBe(true);
});

test('the top error types of the course are listed', async () => {
  const wrapper = await mountView();
  expect(wrapper.get('[data-error="missed-edge-case"]').text()).toContain('2 次');
});

test('a concept lists its attempts with times, its notes in this course, and the labs and tasks that practise it', async () => {
  const wrapper = await mountView();
  await wrapper.get('[data-concept="round-robin"]').trigger('click');
  const detail = wrapper.get('[data-section="concept"]');
  expect(detail.get('[data-field="totals"]').text()).toBe('通过过 · 共 2 次：通过 1，部分通过 0，未通过 1');
  expect(detail.findAll('[data-field="attempts"] li').map((item) => item.get('time').text())).toEqual(['2026-10-27 11:00:00', '2026-10-27 10:00:00']);
  expect(detail.get('[data-field="attempts"]').text()).toContain('独立完成度 95');
  // Only this course's note; the programming one with the same id is another concept.
  expect(detail.findAll('[data-field="notes"] li').map((item) => item.text())).toEqual(['RR 入队顺序']);
  expect(detail.findAll('[data-field="packages"] li').map((item) => item.text())).toEqual(['第 1 阶段 lab：时间片轮转调度已完成', '实现 RR 调度器执行中']);
  const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
  await detail.findAll('[data-field="packages"] button')[0].trigger('click');
  expect(open).toHaveBeenCalledWith('lab-round-robin');
  const goNote = vi.spyOn(useNotesStore(), 'goNote').mockResolvedValue(true);
  await detail.get('[data-field="notes"] button').trigger('click');
  await flushPromises();
  expect(useAppStore().view).toBe('notes');
  expect(goNote).toHaveBeenCalledWith(RR_NOTE.id);
});

test('a pack without a skeleton says so; another pack can be picked', async () => {
  api.mastery.course.mockImplementation((id?: string) =>
    ok({ ...OS_MASTERY, course: { id: id ?? 'programming', title: '编程' }, concepts: [], errorTypes: [] }),
  );
  const wrapper = await mountView();
  expect(wrapper.find('[data-empty="concepts"]').exists()).toBe(true);
  expect(wrapper.find('[data-chart]').exists()).toBe(false);
  expect(wrapper.find('[data-empty="errors"]').exists()).toBe(true);
});

// ========== Pure rules ==========

test('graph labels never become mermaid syntax, and links follow the course', () => {
  const graph = conceptGraph([concept('x', 'a"]; click c0 "http://x', [], 'learning'), concept('y', 'B', ['x', 'gone'], 'mastered')], 'y');
  expect(graph).toContain('c0["a ]  click c0  http://x"]');
  expect(graph).not.toContain('gone');
  expect(graph).toContain('style c1 stroke-width:3px');
  const links = conceptLinks('round-robin', 'programming', [RR_NOTE, note('p.md', { course: null, concepts: ['round-robin'] })], [], 'programming');
  expect(links.notes.map((entry) => entry.id)).toEqual(['p.md']);
  expect(stateCounts(OS_MASTERY.concepts)).toEqual({ new: 2, learning: 0, passed: 1, mastered: 0 });
});

test('opened from a grade, the page shows that pack with its concept picked', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useMasteryStore().openCourse('os', 'round-robin');
  const wrapper = mount(MasteryView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  await flushPromises();
  expect(api.mastery.course).toHaveBeenCalledWith('os');
  expect(wrapper.get('[data-section="concept"] h3').text()).toBe('时间片轮转（RR）');
});

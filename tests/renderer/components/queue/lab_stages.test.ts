// @vitest-environment happy-dom
// The stage bar of a lab repository (components/queue/LabStages.vue): each
// lab's state in stage order, opening a lab's execution page, the next lab
// while it is generated (progress, spend, cancel), writing a ready one into
// the repository, and generating the next one once every stage passed.
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import LabStages from '@/components/queue/LabStages.vue';
import { canGenerateNext, labCourse, labStages, pendingStage } from '@/lib/lab_stages.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { coursePathInterview, installApi, labGeneration, requirement } from '../../requirements_fakes.ts';
import { taskView } from '../../execution_fakes.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), announceAgent: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi({ list: [] });
});

const lab = (stage: number, status: packageTypes.WorkPackageStatus, title: string, blocking = false): packageTypes.TaskView =>
  taskView({
    id: `lab-${stage}`,
    title,
    status,
    lab: { id: `l${stage}`, stage, difficulty: 'easy' },
    dependencies: stage > 1 ? [{ id: `lab-${stage - 1}`, title: null, status: null, waived: false, blocking }] : [],
  });

const course = (labState: Partial<requirementTypes.LabGeneration> | null) =>
  requirement({
    id: 'c1',
    kind: 'course',
    status: 'published',
    course: { ...coursePathInterview(), repositoryId: 'lab-repo', ...(labState ? { lab: labGeneration(labState) } : {}) },
  });

const mountBar = async (tasks: packageTypes.TaskView[], item: requirementTypes.Requirement | null) => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(LabStages, { props: { tasks, course: item }, global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  await flushPromises();
  return wrapper;
};

const states = (wrapper: Awaited<ReturnType<typeof mountBar>>) =>
  wrapper
    .findAll('[data-stage]')
    .map((segment) => [
      segment.attributes('data-stage'),
      segment.attributes('data-state'),
      `${segment.get('.lab-stage-title').text()} · ${segment.get('.lab-stage-state').text()}`,
    ]);

test('each lab shows its state in stage order: passed, waiting for review, in progress, locked', async () => {
  const wrapper = await mountBar(
    [lab(3, 'pending', '优先级调度', true), lab(1, 'done', '先来先服务'), lab(2, 'accepting', '时间片轮转')],
    course({ stage: 2, placed: true }),
  );
  expect(states(wrapper)).toEqual([
    ['1', 'passed', '先来先服务 · 已通过'],
    ['2', 'review', '时间片轮转 · 待复核'],
    ['3', 'locked', '优先级调度 · 锁定'],
  ]);
  expect(wrapper.text()).toContain('1 / 3 个 lab 已通过');
  expect(wrapper.find('[data-action="next-lab"]').exists()).toBe(false);
});

test('a project repository has no stage bar', async () => {
  const wrapper = await mountBar([taskView()], null);
  expect(wrapper.find('[data-lab-stages]').exists()).toBe(false);
});

test('clicking a lab opens its execution page', async () => {
  const wrapper = await mountBar([lab(1, 'in_progress', '时间片轮转')], course({ stage: 1, placed: true }));
  const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
  expect(states(wrapper)).toEqual([['1', 'active', '时间片轮转 · 进行中']]);
  await wrapper.get('[data-stage="1"] button').trigger('click');
  expect(open).toHaveBeenCalledWith('lab-1');
});

test('the next lab being generated shows as a stage with its progress and spend, and can be cancelled', async () => {
  const item = course({ status: 'running', phase: 'verify', stage: 2, placed: false, lab: null, costUsd: 0.85 });
  const wrapper = await mountBar([lab(1, 'done', '时间片轮转')], item);
  expect(states(wrapper)).toEqual([
    ['1', 'passed', '时间片轮转 · 已通过'],
    ['2', 'generating', '下一个 lab · 生成中'],
  ]);
  const run = wrapper.get('[data-field="lab-run"]').text();
  expect(run).toContain('正在自验证');
  expect(run).toContain('花费 $0.850');
  await wrapper.get('[data-action="cancel-lab"]').trigger('click');
  await flushPromises();
  expect(api.requirements.cancel).toHaveBeenCalledWith('c1');
});

test('a ready lab is written into the repository from the bar', async () => {
  const item = course({ status: 'ready', stage: 2, placed: false });
  const wrapper = await mountBar([lab(1, 'done', '先来先服务')], item);
  expect(states(wrapper)[1]).toEqual(['2', 'generating', '时间片轮转调度 · 待写入']);
  await wrapper.get('[data-action="place-lab"]').trigger('click');
  await flushPromises();
  expect(api.requirements.labPlace).toHaveBeenCalledWith('c1');
  expect(api.tasks.list).toHaveBeenCalled();
});

test('once every stage passed the next lab can be generated, starting from its estimate', async () => {
  const item = course({ status: 'ready', stage: 1, placed: true });
  const wrapper = await mountBar([lab(1, 'done', '时间片轮转')], item);
  const nextLab = vi.spyOn(useRequirementsStore(), 'nextLab').mockResolvedValue();
  await wrapper.get('[data-action="next-lab"]').trigger('click');
  expect(nextLab).toHaveBeenCalledWith(item);
});

test('a failed or cancelled next lab says so on the bar', async () => {
  const cancelled = await mountBar([lab(1, 'done', '时间片轮转')], course({ status: 'failed', stage: 2, error: { code: 'agent_cancelled', message: '' } }));
  expect(cancelled.get('[data-field="lab-failed"]').text()).toBe('已取消生成下一个 lab。');
  expect(cancelled.find('[data-action="next-lab"]').exists()).toBe(true);
});

// ========== Pure rules ==========

test('the stage model: a blocked stage is locked, the course is the one pointing at the open repository', () => {
  const stages = labStages([lab(2, 'pending', 'b', true), lab(1, 'in_review', 'a')]);
  expect(stages.map((stage) => [stage.stage, stage.state])).toEqual([
    [1, 'review'],
    [2, 'locked'],
  ]);
  const item = course(null);
  expect(labCourse([requirement(), item], 'lab-repo')).toBe(item);
  expect(labCourse([item], 'other')).toBeNull();
  expect(labCourse([item], null)).toBeNull();
  // Nothing pending without a lab, or once it is written.
  expect(pendingStage(item.course, stages)).toBeNull();
  expect(pendingStage(course({ status: 'ready', stage: 3, placed: true }).course, stages)).toBeNull();
  expect(canGenerateNext(item.course, stages)).toBe(false);
  expect(canGenerateNext(item.course, labStages([lab(1, 'done', 'a')]))).toBe(true);
});

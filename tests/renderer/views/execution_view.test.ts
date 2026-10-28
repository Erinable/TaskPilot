// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import ExecutionView from '../../../src/renderer/src/views/ExecutionView.vue';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import type * as tutorTypes from '../../../src/shared/ipc/tutor.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

let current: { task: packageTypes.TaskView };
let api: ReturnType<typeof installApi>;

const mountOpen = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const execution = useExecutionStore();
  await execution.open(current.task.id);
  const wrapper = mount(ExecutionView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, execution };
};

beforeEach(() => {
  document.body.replaceChildren();
  current = { task: taskView() };
  api = installApi(current);
});

describe('ExecutionView', () => {
  // Runs a folded action the way the dropdown's command event does.
  const runFolded = async (wrapper: ReturnType<typeof mount>, name: string) => {
    wrapper.findComponent({ name: 'ElDropdown' }).vm.$emit('command', name);
    await flushPromises();
  };

  test('the advised action leads and the rest fold under 更多操作 in ACTIONS order', async () => {
    current.task = taskView({ completedSteps: [0, 1], humanTransitions: ['release', 'report_deviation', 'submit_for_review', 'block'] });
    const { wrapper } = await mountOpen();
    expect(wrapper.get('.exec-actions > [data-transition]').attributes('data-transition')).toBe('submit_for_review');
    expect(wrapper.find('[data-action="more-transitions"]').exists()).toBe(true);
    expect(wrapper.findAllComponents({ name: 'ElDropdownItem' }).map((item) => item.props('command'))).toEqual(['report_deviation', 'block', 'release']);
    wrapper.unmount();
  });

  test('with steps left, the advice offers the Coding Agent first and it leads the page', async () => {
    current.task = taskView({ completedSteps: [], humanTransitions: ['submit_for_review', 'block'] });
    const { wrapper } = await mountOpen();
    expect(wrapper.get('[data-next-step]').text()).toContain('交给 Coding Agent');
    expect(wrapper.find('.exec-actions > [data-transition]').exists()).toBe(false);
    expect(wrapper.find('[data-action="more-transitions"]').exists()).toBe(true);
    // The instruction comes prefilled, so one click hands the package over.
    const handOff = wrapper.get('[data-action="hand-off"]');
    expect(handOff.attributes('disabled')).toBeUndefined();
    // The Coding Agent panel sits above the two columns.
    expect(wrapper.find('.view > .coding-panel').exists()).toBe(true);
    await handOff.trigger('click');
    await flushPromises();
    expect(api.coding.start).toHaveBeenCalledWith('t1', { instruction: expect.stringContaining('执行指令') });
    wrapper.unmount();
  });

  test('while the AI team works, the advice says so and there are no actions', async () => {
    current.task = taskView({ status: 'in_review', statusLabel: '审查中' });
    const { wrapper } = await mountOpen();
    expect(wrapper.get('[data-next-step]').text()).toContain('QA Partner 正在检查改动');
    expect(wrapper.find('.exec-actions [data-transition]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('a practised package shows no Coding Agent and says who writes the code', async () => {
    current.task = taskView({ completedSteps: [], mode: 'practice', humanTransitions: ['submit_for_review', 'release'] });
    const { wrapper } = await mountOpen();
    expect(wrapper.find('.coding-panel').exists()).toBe(false);
    expect(wrapper.find('[data-action="hand-off"]').exists()).toBe(false);
    expect(wrapper.get('[data-mode-chip]').text()).toBe('自己练习');
    wrapper.unmount();
  });

  test('starting a package asks who writes it, with the plan recommendation preselected', async () => {
    current.task = taskView({
      status: 'pending',
      baseline: null,
      claimedAt: null,
      humanTransitions: ['claim'],
      recommendedMode: { mode: 'ai', reason: '只是改配置，练手意义不大。' },
    });
    const { wrapper } = await mountOpen();
    await wrapper.get('.exec-actions > [data-transition="claim"]').trigger('click');
    await flushPromises();
    expect(api.packages.transition).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-recommendation]')?.textContent).toContain('只是改配置，练手意义不大。');
    (document.body.querySelector('[data-mode="practice"] input') as HTMLInputElement).click();
    await flushPromises();
    (document.body.querySelector('[data-action="confirm-claim"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'claim', { mode: 'practice' });
    wrapper.unmount();
  });

  test('a folded action runs the transition and reloads', async () => {
    current.task = taskView({ humanTransitions: ['block'] });
    const { wrapper } = await mountOpen();
    api.tasks.get.mockClear();
    await runFolded(wrapper, 'block');
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'block');
    wrapper.unmount();
  });

  test('agent-authored text renders as text, with backticks as <code>', async () => {
    const payload = '<img src=x onerror="alert(1)">';
    current.task = taskView({
      title: payload,
      steps: [`运行 \`${payload}\``],
      deviations: [
        {
          note: payload,
          stepIndex: 0,
          filePath: 'src/auth.ts',
          reportedAt: '2026-01-02T00:00:00.000Z',
          resolution: { decision: 'dismiss', reason: payload, changes: [payload], decidedAt: '', afterContest: false, contested: false, reverted: false },
        },
      ],
      review: {
        status: 'rejected',
        error: null,
        startedAt: '',
        finishedAt: null,
        reasons: ['qa_rejected'],
        attention: [],
        checks: [],
        verification: null,
        acceptance: [],
        report: { verdict: 'reject', summary: payload, criteria: [], issues: [{ severity: 'major', text: payload, file: null, line: null }] },
        diff: { files: [], skipped: [], outOfScope: [] },
        costUsd: 0,
      },
    });
    const { wrapper } = await mountOpen();
    expect(document.querySelector('img')).toBeNull();
    expect(wrapper.find('h1').text()).toBe(payload);
    expect(wrapper.find('.step-text code').text()).toBe(payload);
    expect(wrapper.find('.deviation-item p').text()).toBe(payload);
    expect(wrapper.find('.review-summary').text()).toBe(payload);
    expect(wrapper.find('.review-issue p').text()).toBe(payload);
    wrapper.unmount();
  });

  test('the deviation dialog sends the chosen step and file', async () => {
    current.task = taskView({ humanTransitions: ['report_deviation'] });
    const { wrapper, execution } = await mountOpen();
    await runFolded(wrapper, 'report_deviation');
    expect(execution.deviationOpen).toBe(true);
    expect(document.querySelector('#deviationTitle')?.textContent).toBe('报告偏差');
    // The selects are Element Plus; drive the form the way their v-model does.
    execution.deviationForm = { note: '接口不一致', stepIndex: 0, filePath: null };
    await flushPromises();
    const submit = [...document.querySelectorAll('.modal-actions .primary-button')].find((node) => node.textContent?.includes('提交偏差')) as HTMLButtonElement;
    submit.click();
    await flushPromises();
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'report_deviation', { deviation: { note: '接口不一致', stepIndex: 0, filePath: null } });
    expect(execution.deviationOpen).toBe(false);
    wrapper.unmount();
  });
  test('unmounting the view clears the package', async () => {
    const { wrapper, execution } = await mountOpen();
    wrapper.unmount();
    expect(execution.current).toBeNull();
  });

  test('an accepted package offers to commit the scope files with an editable message', async () => {
    current.task = taskView({ status: 'done', statusLabel: '已完成' });
    const { wrapper } = await mountOpen();
    const panel = wrapper.get('[data-panel="commit"]');
    expect(panel.findAll('.commit-files code').map((node) => node.text())).toEqual(['src/auth.ts']);
    expect(panel.get('.commit-skipped').text()).toContain('notes.md');
    expect((panel.get('#commitMessage').element as HTMLTextAreaElement).value).toBe('邮箱登录\n\nTaskPilot 工作包 t1');
    await panel.get('#commitMessage').setValue('登录：支持邮箱');
    await panel.get('.commit-actions button').trigger('click');
    await flushPromises();
    expect(api.commit.create).toHaveBeenCalledWith('t1', '登录：支持邮箱', ['src/auth.ts']);
    expect(wrapper.get('.commit-done').text()).toContain('c0ffee12');
    wrapper.unmount();
  });
  test('a package still in progress has no commit panel', async () => {
    const { wrapper } = await mountOpen();
    expect(wrapper.find('[data-panel="commit"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test('an accepted package with no changed files explains why it cannot commit', async () => {
    current.task = taskView({ status: 'done', statusLabel: '已完成' });
    api.commit.preview.mockReturnValueOnce(Promise.resolve({ ok: true as const, data: { files: [], skipped: [], message: '' } }));
    const { wrapper } = await mountOpen();
    expect(wrapper.get('[data-empty="commit"]').text()).toContain('没有未提交的改动');
    expect(wrapper.find('.commit-actions').exists()).toBe(false);
    wrapper.unmount();
  });

  test('the hint ladder opens the next level on request, shows every opened level and counts copies', async () => {
    const level = (number: number, snippet: tutorTypes.TutorAnswer['snippet'] = null): tutorTypes.TutorLevel => ({
      level: number,
      answer: { explanation: `L${number} 说明`, hints: [], snippet, terms: [] },
      filtered: number === 3,
      source: number === 2 ? 'lab' : 'tutor',
      costUsd: 0,
    });
    const three = [level(1), level(2), level(3)];
    api.tutor.get.mockResolvedValue({ ok: true, data: { status: 'done', levels: three, pending: null, opened: 3, maxLevel: 5, error: null } });
    const { wrapper } = await mountOpen();
    await wrapper.get('[data-tutor="0"] .link-button').trigger('click');
    await flushPromises();
    // Opening shows what is already open; it asks for nothing.
    expect(api.tutor.ask).not.toHaveBeenCalled();
    const card = wrapper.get('.tutor-card');
    expect(card.get('[data-ladder]').text()).toBe('已用 L3 / 共 5 级');
    expect(card.findAll('[data-level]').map((node) => node.attributes('data-level'))).toEqual(['1', '2', '3']);
    expect(card.get('[data-level="2"]').text()).toContain('lab 自带的提示');
    expect(card.get('[data-level="3"]').text()).toContain('已经去掉');

    const four = [...three, level(4, { language: 'ts', code: 'if (count >= MAX) lock();' })];
    api.tutor.ask.mockResolvedValueOnce({ ok: true, data: { status: 'done', levels: four, pending: null, opened: 4, maxLevel: 5, error: null } });
    expect(card.get('[data-next-level]').text()).toContain('看 L4');
    await card.get('[data-next-level]').trigger('click');
    await flushPromises();
    expect(api.tutor.ask).toHaveBeenCalledWith('t1', 0, 4);
    expect(wrapper.get('[data-ladder]').text()).toBe('已用 L4 / 共 5 级');
    expect(wrapper.get('[data-level="4"] pre code').text()).toBe('if (count >= MAX) lock();');

    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await wrapper.get('[data-level="4"] .tutor-snippet-head button').trigger('click');
    await flushPromises();
    expect(api.tutor.copied).toHaveBeenCalledWith('t1');
    wrapper.unmount();
  });

  test('each scope file opens in the editor', async () => {
    const { wrapper } = await mountOpen();
    const open = wrapper.get('.scope-row .scope-open');
    expect(open.attributes('aria-label')).toBe('在编辑器中打开 src/auth.ts');
    await open.trigger('click');
    await flushPromises();
    expect(api.workspace.openFile).toHaveBeenCalledWith('src/auth.ts', null);
    wrapper.unmount();
  });

  test('a QA issue jumps to its file and line, and a failed test run is explained', async () => {
    current.task = taskView({
      status: 'in_progress',
      review: {
        status: 'rejected',
        error: null,
        startedAt: '',
        finishedAt: null,
        reasons: ['tests_failed'],
        attention: [],
        checks: [],
        verification: {
          kind: 'test',
          command: 'npm test',
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
          summary: { total: 2, passed: 1, failed: 1, skipped: 0, ok: false },
          report: null,
          failing: ['login works'],
          outputTail: 'not ok 2 - login works\n  expected: 200\n  actual: 401',
        },
        acceptance: [],
        report: { verdict: 'reject', summary: 's', criteria: [], issues: [{ severity: 'major', text: '没有校验邮箱', file: 'src/auth.ts', line: 42 }] },
        diff: { files: [], skipped: [], outOfScope: [] },
        costUsd: 0,
      },
    });
    const { wrapper } = await mountOpen();
    const location = wrapper.get('.review-issue .issue-location');
    expect(location.text()).toBe('src/auth.ts:42');
    await location.trigger('click');
    await flushPromises();
    expect(api.workspace.openFile).toHaveBeenCalledWith('src/auth.ts', 42);
    const explained = wrapper.get('.failure-explain');
    expect(explained.get('strong').text()).toBe('1 个测试没通过');
    // The raw tail stays one click away, folded.
    const details = wrapper.get('.verify-output-details');
    expect(details.attributes('open')).toBeUndefined();
    expect(details.get('pre').text()).toContain('actual: 401');
    wrapper.unmount();
  });

  test('a failed verification run explains itself above the folded log', async () => {
    api.verify.run.mockResolvedValue({
      ok: true,
      data: {
        kind: 'test',
        command: 'npm test',
        exitCode: 1,
        timedOut: false,
        durationMs: 20,
        output: "Error: Cannot find module './session'",
        results: [],
        diagnostics: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, ok: false },
        report: { format: 'stdout', trusted: true, problem: null },
        check: { stage: 'step', blocking: true },
      },
    });
    const { wrapper } = await mountOpen();
    await wrapper.get('[data-verify="test"]').trigger('click');
    await flushPromises();
    const explained = wrapper.get('.verify-result .failure-explain');
    expect(explained.get('strong').text()).toBe('有一个模块找不到');
    expect(explained.get('code').text()).toBe('./session');
    expect(wrapper.get('.verify-result .verify-output').text()).toContain('Cannot find module');
    wrapper.unmount();
  });
});

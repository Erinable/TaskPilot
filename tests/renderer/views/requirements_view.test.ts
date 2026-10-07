// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import RequirementsView from '../../../src/renderer/src/views/RequirementsView.vue';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { installApi, planPackage, requirement } from '../requirements_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const MARKUP = '<img src=x onerror="alert(1)">';

describe('RequirementsView', () => {
  let state: { list: ReturnType<typeof requirement>[] };
  let api: ReturnType<typeof installApi>;
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    state = { list: [] };
    api = installApi(state);
  });

  const render = async (options: { compose?: boolean; id?: string } = {}) => {
    const store = useRequirementsStore();
    await store.open(options);
    const wrapper = mount(RequirementsView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    await flushPromises();
    return { wrapper, store };
  };

  test('shows the empty pane and a list hint when there are no requirements', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.req-list .empty-hint').text()).toBe('还没有需求');
    expect(wrapper.find('.req-empty h2').text()).toBe('从一个需求开始');
    await wrapper.find('.req-empty .primary-button').trigger('click');
    expect(wrapper.find('form[data-pane="new"]').exists()).toBe(true);
    wrapper.unmount();
  });

  test('list rows carry the status pill and the active row', async () => {
    state.list = [requirement({ id: 'a', status: 'planning', title: '' }), requirement({ id: 'b', status: 'failed' })];
    const { wrapper } = await render({ id: 'b' });
    const rows = wrapper.findAll('.req-row');
    expect(rows[0].find('.req-row-title').text()).toBe('用户可以用邮箱登录。');
    expect(rows[0].find('.status-pill').classes()).toContain('in_progress');
    expect(rows[0].find('.spin').exists()).toBe(true);
    expect(rows[1].classes()).toContain('active');
    expect(rows[1].find('.status-pill').text()).toBe('失败');
    wrapper.unmount();
  });

  test('the detail header shows the pill and stepper for the status', async () => {
    state.list = [requirement({ status: 'reviewing', plan: { summary: 'plan', packages: [planPackage()] } })];
    const { wrapper } = await render();
    expect(wrapper.find('.req-title-row .status-pill').classes()).toContain('in_review');
    const steps = wrapper.findAll('.req-stepper li');
    expect(
      steps.map((step) =>
        step
          .classes()
          .filter((name) => name !== '')
          .join(' '),
      ),
    ).toEqual(['done', 'done', 'done', 'current']);
    wrapper.unmount();
  });

  test('agent-written text renders as text, with backtick spans as code', async () => {
    state.list = [
      requirement({
        title: MARKUP,
        text: MARKUP,
        summary: `用 \`${MARKUP}\` 做`,
        questions: [{ text: `问题 ${MARKUP} \`code\``, answer: '' }],
      }),
    ];
    const { wrapper } = await render();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.req-title-row h2').text()).toBe(MARKUP);
    expect(wrapper.find('.req-original p').text()).toBe(MARKUP);
    expect(wrapper.find('.agent-message code').text()).toBe(MARKUP);
    expect(wrapper.find('.question-text code').text()).toBe('code');
    wrapper.unmount();
  });

  test('answers are limited to 1000 characters and submitted in order', async () => {
    state.list = [
      requirement({
        questions: [
          { text: 'q1', answer: '已有' },
          { text: 'q2', answer: '' },
        ],
      }),
    ];
    const { wrapper } = await render();
    const inputs = wrapper.findAll('.question-card textarea');
    expect(inputs.map((input) => input.attributes('maxlength'))).toEqual(['1000', '1000']);
    expect(inputs[0].attributes('id')).toBe('reqAnswer0');
    expect((inputs[0].element as HTMLTextAreaElement).value).toBe('已有');
    await inputs[1].setValue('第二个');
    await wrapper.find('.req-questions').trigger('submit');
    await flushPromises();
    expect(api.requirements.plan).toHaveBeenCalledWith('r1', ['已有', '第二个']);
    expect(wrapper.find('.agent-running').text()).toBe('正在拆解工作包…');
    wrapper.unmount();
  });

  test('"不确定，用推荐做法" clears the answer, so Product Lead picks a default', async () => {
    state.list = [
      requirement({
        questions: [
          { text: 'q1', answer: '草稿' },
          { text: 'q2', answer: '' },
        ],
      }),
    ];
    const { wrapper } = await render();
    const button = wrapper.get('[data-default="0"]');
    expect(button.text()).toBe('不确定，用推荐做法');
    await button.trigger('click');
    expect(button.text()).toBe('将使用推荐做法');
    expect(button.attributes('aria-pressed')).toBe('true');
    expect((wrapper.findAll('.question-card textarea')[0].element as HTMLTextAreaElement).value).toBe('');
    await wrapper.get('.req-questions').trigger('submit');
    await flushPromises();
    expect(api.requirements.plan).toHaveBeenCalledWith('r1', ['', '']);
    wrapper.unmount();
  });

  test('compose: required error, code point count, and ⌘↩ submits', async () => {
    const { wrapper, store } = await render({ compose: true });
    const textarea = wrapper.find('#reqText');
    expect(textarea.element.tagName).toBe('TEXTAREA');
    expect(document.activeElement).toBe(textarea.element);
    await wrapper.find('form[data-pane="new"]').trigger('submit');
    await flushPromises();
    expect(wrapper.find('#reqTextStatus').text()).toBe('请先描述需求。');
    expect(wrapper.find('#reqTextStatus').classes()).toContain('error');
    expect(textarea.attributes('aria-invalid')).toBe('true');
    expect(api.requirements.create).not.toHaveBeenCalled();

    await textarea.setValue('😀😀');
    expect(wrapper.find('.char-count').text()).toBe('2/4000');
    expect(wrapper.find('#reqTextStatus').text()).toBe('');
    expect(textarea.attributes('aria-invalid')).toBe('false');
    await textarea.setValue('x'.repeat(4001));
    expect(wrapper.find('.char-count').classes()).toContain('over');

    await textarea.setValue('邮箱登录');
    await textarea.trigger('keydown', { key: 'Enter', metaKey: true });
    await flushPromises();
    expect(api.requirements.create).toHaveBeenCalledWith({ title: '', text: '邮箱登录' });
    expect(store.pane).toBe('detail');
    store.stopPolling();
    wrapper.unmount();
  });

  test('compose shows what the agents will see, and warns when the CLI is missing', async () => {
    api.agent.status.mockResolvedValueOnce({ ok: true, data: { available: false, command: null } });
    api.workspace.info.mockResolvedValueOnce({ ok: true, data: { configured: true, root: '/Users/me/projects/app' } as never });
    const { wrapper } = await render({ compose: true });
    expect(wrapper.find('.req-context-list li').text()).toContain('Architect 会读取仓库 app 中');
    expect(wrapper.find('.req-warning').text()).toContain('找不到 Claude Code CLI');
    wrapper.unmount();
  });

  test('publishing disables the button and reloads the queue', async () => {
    state.list = [requirement({ status: 'reviewing', plan: { summary: 'plan', packages: [planPackage()] } })];
    const { wrapper } = await render();
    const publish = wrapper.findAll('.req-actions.sticky button').at(-1)!;
    expect(publish.text()).toBe('发布 1 个工作包');
    await publish.trigger('click');
    await flushPromises();
    expect(api.requirements.publish).toHaveBeenCalledWith('r1');
    expect(api.listTasks).toHaveBeenCalled();
    expect(wrapper.find('.req-actions.sticky button').text()).toBe('查看工作队列');
    expect(wrapper.find('.req-delete').exists()).toBe(false);
    wrapper.unmount();
  });

  test('a running requirement can be cancelled', async () => {
    state.list = [requirement({ status: 'clarifying', phase: 'architect' })];
    const { wrapper, store } = await render();
    expect(wrapper.find('.agent-message-head strong').text()).toBe('Architect');
    expect(wrapper.find('.agent-running').text()).toBe('Architect 正在阅读相关代码…');
    const cancel = wrapper.find('.agent-message .secondary-button');
    await cancel.trigger('click');
    expect(cancel.attributes('disabled')).toBeDefined();
    expect(api.requirements.cancel).toHaveBeenCalledWith('r1');
    store.stopPolling();
    wrapper.unmount();
  });

  test('a failed plan offers retry and editing answers, without the cancelled detail', async () => {
    state.list = [requirement({ status: 'failed', failedStep: 'planning', error: { code: 'agent_timeout', message: 'raw detail' } })];
    const { wrapper } = await render();
    expect(wrapper.find('.agent-message.failed p').text()).toBe('智能体超过 3 分钟没有完成，已停止。');
    expect(wrapper.find('.agent-error-detail').text()).toBe('raw detail');
    expect(wrapper.findAll('.req-actions button').map((button) => button.text())).toEqual(['重新拆解', '修改回答']);
    expect(wrapper.find('.req-stepper li[data-step="plan"]').classes()).toContain('failed');
    wrapper.unmount();
  });

  test('the interface summary lists modules, sections and skipped files', async () => {
    state.list = [
      requirement({
        interfaces: {
          summary: {
            modules: [{ path: 'src/a.ts', purpose: 'A', members: [{ name: 'a', signature: 'a(): void' }], dependsOn: ['b'], notes: ['n'] }],
            conventions: ['c'],
            gaps: [],
          },
          text: 't',
          read: [{ path: 'src/a.ts', sha: '1' }],
          skipped: [{ path: '.env', reason: 'secret' }],
          error: null,
        },
      }),
    ];
    const { wrapper } = await render();
    expect(wrapper.find('.interfaces-headline').text()).toBe('读取了 1 个文件，整理出 1 个模块的接口');
    expect(wrapper.find('.interface-members').text()).toBe('a(): void');
    expect(wrapper.find('.interface-deps').text()).toBe('依赖 b');
    expect(wrapper.findAll('.interface-section h4').map((heading) => heading.text())).toEqual(['仓库约定', '未读取']);
    expect(wrapper.find('.interface-section.skipped li').text()).toBe('.env（可能含密钥）');
    wrapper.unmount();
  });
});

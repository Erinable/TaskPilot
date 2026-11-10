// @vitest-environment happy-dom
/** @module-tag integration */
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import EnvironmentPage from '@/components/settings/EnvironmentPage.vue';
import AgentsPage from '@/components/settings/AgentsPage.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import { mountView } from '../../mount_view.ts';
import { fail, installApi, ok, preferences } from '../../settings_fakes.ts';
import type { EnvironmentInfo } from '@shared/ipc/settings.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

const environmentInfo = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  requested: 'auto',
  source: 'auto',
  error: null,
  shell: '/bin/zsh',
  entries: ['/usr/bin', '/Users/ada/.local/bin'],
  inheritedCount: 1,
  platform: 'darwin',
  versions: { app: '0.1.0', electron: '40', node: '22' },
  tools: [
    {
      id: 'claude',
      label: 'Claude Code',
      path: '/Users/ada/.local/bin/claude',
      realPath: '/Users/ada/.local/share/claude/versions/2.0.0',
      requiresNode: false,
      problem: null,
    },
    {
      id: 'codex',
      label: 'Codex',
      path: '/Users/ada/.nvm/versions/node/v22.0.0/bin/codex',
      realPath: '/Users/ada/.nvm/versions/node/v22.0.0/lib/node_modules/@openai/codex/bin/codex.js',
      requiresNode: true,
      problem: '已找到 CLI 入口，但未找到本机 Node.js，请选择 node 可执行文件。',
    },
    { id: 'node', label: 'Node.js', path: null, realPath: null, requiresNode: false, problem: '未找到本机 Node.js' },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

const setup = async (info = environmentInfo()) => {
  const prefs = { ...preferences(), environment: { pathSource: info.requested, extraPaths: ['/existing/bin'] } };
  const api = installApi({
    preferences: { get: () => ok(prefs), set: (input) => ok({ ...input, profile: { ...input.profile, initials: 'A' } }) },
    environment: { info: () => ok(info), pickExecutable: () => ok(null) },
  });
  const settings = useSettingsStore();
  await settings.open('profile');
  await settings.renderEnvironment();
  const wrapper = await mountView(EnvironmentPage);
  return { api, settings, wrapper };
};

test('the recommended automatic mode is selectable and previews without saving', async () => {
  const { api, settings, wrapper } = await setup();
  expect(wrapper.get('input[value="auto"]').element).toHaveProperty('checked', true);
  expect(wrapper.get('input[value="auto"]').element.closest('label')?.textContent).toContain('自动检测（推荐）');
  await wrapper.get('input[value="inherit"]').setValue(true);
  await flushPromises();
  expect(settings.preferencesDraft!.environment.pathSource).toBe('inherit');
  await wrapper.get('input[value="auto"]').setValue(true);
  await flushPromises();
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'auto', extraPaths: ['/existing/bin'], refresh: false });
  expect(api.preferences.set).not.toHaveBeenCalled();
});

test('a login-shell timeout preserves found tools and describes local discovery rather than bare system PATH fallback', async () => {
  const { wrapper } = await setup(
    environmentInfo({
      requested: 'login-shell',
      source: 'auto',
      error: { code: 'shell_timeout', message: 'shell took too long' },
      entries: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Users/ada/.local/bin'],
      inheritedCount: 4,
    }),
  );
  const note = wrapper.get('#pathSourceNote');
  expect(note.text()).toContain('登录 shell 超时');
  expect(note.text()).toContain('本机工具自动检测结果');
  expect(note.text()).not.toMatch(/退回|继承的 PATH|4 个目录/);
  expect(wrapper.get('#shellSummary').text()).toContain('超时时仍使用本机自动检测结果');
  const claude = wrapper.findAll('.runtime-tool').find((row) => row.text().includes('Claude Code'))!;
  expect(claude.text()).toContain('/Users/ada/.local/bin/claude');
  expect(claude.text()).toContain('已找到可执行文件');
  expect(wrapper.get('#pathList').text()).toContain('/Users/ada/.local/bin');
});

test('tool rows show full entry and resolved paths and distinguish a missing external Node runtime', async () => {
  const { wrapper } = await setup();
  const rows = wrapper.findAll('.runtime-tool');
  const claude = rows.find((row) => row.text().includes('Claude Code'))!;
  expect(claude.get('code').text()).toBe('/Users/ada/.local/bin/claude');
  expect(claude.get('.runtime-real-path').text()).toBe('实际文件：/Users/ada/.local/share/claude/versions/2.0.0');
  const codex = rows.find((row) => row.text().includes('Codex'))!;
  expect(codex.get('code').text()).toBe('/Users/ada/.nvm/versions/node/v22.0.0/bin/codex');
  expect(codex.get('.runtime-real-path').text()).toContain('/Users/ada/.nvm/versions/node/v22.0.0/lib/node_modules/@openai/codex/bin/codex.js');
  expect(codex.text()).toContain('未找到本机 Node.js');
  expect(codex.text()).not.toContain('已找到入口和本机 Node.js');
  const node = rows.find((row) => row.get('strong').text() === 'Node.js')!;
  expect(node.text()).toContain('未找到本机 Node.js');
  expect(node.find('code').exists()).toBe(false);
  expect(wrapper.text()).toContain('不是应用内置版本');
});

test('each file chooser identifies its runtime and cancellation does not modify or persist settings', async () => {
  const { api, settings, wrapper } = await setup();
  api.environment.info.mockClear();
  const initial = settings.extraPathText;
  for (const [index, tool] of ['claude', 'codex', 'node'].entries()) {
    await wrapper.findAll('.runtime-tool')[index].get('button').trigger('click');
    await flushPromises();
    expect(api.environment.pickExecutable).toHaveBeenLastCalledWith(tool);
    expect(settings.extraPathText).toBe(initial);
  }
  expect(api.environment.info).not.toHaveBeenCalled();
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(settings.anyDirty).toBe(false);
});

test('selecting the Node executable adds its directory to the local draft and renders picker errors for retry', async () => {
  const { api, settings, wrapper } = await setup();
  const nodeButton = () =>
    wrapper
      .findAll('.runtime-tool')
      .find((row) => row.get('strong').text() === 'Node.js')!
      .get('button');
  api.environment.pickExecutable.mockImplementationOnce(() => fail('invalid_argument', '选择的文件不是可执行文件'));
  await nodeButton().trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('选择的文件不是可执行文件');
  expect(settings.extraPathText).toBe('/existing/bin');
  api.environment.pickExecutable.mockResolvedValueOnce({ ok: true, data: { path: '/chosen/node/bin/node', directory: '/chosen/node/bin' } });
  await nodeButton().trigger('click');
  await flushPromises();
  expect(settings.extraPathText).toBe('/chosen/node/bin\n/existing/bin');
  expect(wrapper.get<HTMLTextAreaElement>('#extraCommandPaths').element.value).toBe('/chosen/node/bin\n/existing/bin');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(api.preferences.set).not.toHaveBeenCalled();
});

test('the CLI refresh button explicitly refreshes runtime discovery', async () => {
  const { api } = await setup();
  const wrapper = await mountView(AgentsPage);
  const refresh = wrapper.findAll('button').find((button) => button.text().includes('刷新 CLI 与目录'))!;
  api.agent.runtimes.mockClear();
  await refresh.trigger('click');
  await flushPromises();
  expect(api.agent.runtimes).toHaveBeenCalledOnce();
  expect(api.agent.runtimes).toHaveBeenCalledWith({ refresh: true });
});

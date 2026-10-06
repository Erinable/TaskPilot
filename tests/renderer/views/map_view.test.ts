// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import MapView from '@/views/MapView.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import type * as ipc from '@shared/ipc_types.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

const source = { requirementId: 'r1', title: '邮箱登录', at: '2026-01-02T03:00:00.000Z' };

const mapModule = (overrides: Partial<ipc.MapModule> = {}): ipc.MapModule => ({
  path: 'src/main/ipc.ts',
  purpose: '注册 `ipcMain` 处理器',
  members: [{ name: 'registerIpc', signature: '(ipcMain: IpcMain) => void' }],
  dependsOn: ['src/main/tasks.ts', 'electron'],
  notes: ['通道名与 preload 重复'],
  source,
  freshness: 'current',
  ...overrides,
});

const engineeringMap = (overrides: Partial<ipc.EngineeringMap> = {}): ipc.EngineeringMap => ({
  modules: [
    mapModule(),
    mapModule({
      path: 'src/main/tasks.ts',
      purpose: '示例数据',
      members: [],
      dependsOn: [],
      notes: [],
      freshness: 'stale',
      source: { ...source, requirementId: 'r2', title: '任务列表' },
    }),
  ],
  conventions: [{ text: '用 `node:test`', source }],
  gaps: [{ text: '没有读到 renderer', source }],
  files: ['src/main/ipc.ts', 'src/main/tasks.ts', 'src/main/index.ts', 'README.md'],
  truncated: false,
  ...overrides,
});

let state: { result: { ok: true; data: ipc.EngineeringMap } | { ok: false; error: ipc.ErrorInfo } };
let get: ReturnType<typeof vi.fn>;
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state = { result: { ok: true, data: engineeringMap() } };
  get = vi.fn(() => Promise.resolve(state.result));
  (window as unknown as { taskpilot: unknown }).taskpilot = { engineeringMap: { get } };
  pinia = createPinia();
  setActivePinia(pinia);
});

const render = async () => {
  const wrapper = mount(MapView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
};

describe('MapView', () => {
  test('without any module it explains where summaries come from', async () => {
    state.result = { ok: true, data: engineeringMap({ modules: [], conventions: [], gaps: [] }) };
    const open = vi.spyOn(useRequirementsStore(), 'open').mockResolvedValue();
    const wrapper = await render();
    const empty = wrapper.get('[data-empty="modules"]');
    expect(empty.find('h2').text()).toBe('还没有模块摘要');
    expect(empty.find('[data-empty="workspace"]').exists()).toBe(false);
    await empty.get('.primary-button').trigger('click');
    expect(open).toHaveBeenCalledWith({ compose: true });
  });

  test('without a workspace it links to the repository settings', async () => {
    state.result = { ok: true, data: engineeringMap({ modules: [], conventions: [], gaps: [], files: [] }) };
    const open = vi.spyOn(useSettingsStore(), 'open').mockResolvedValue();
    const wrapper = await render();
    expect(wrapper.get('[data-empty="workspace"]').text()).toContain('请先配置工作区仓库');
    await wrapper.get('[data-action="settings"]').trigger('click');
    expect(open).toHaveBeenCalledWith('repository');
  });

  test('summaries without files still show, with the settings hint in the tree panel', async () => {
    state.result = { ok: true, data: engineeringMap({ files: [] }) };
    const wrapper = await render();
    expect(wrapper.find('.map-tree-panel [data-empty="workspace"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-module]')).toHaveLength(2);
  });

  test('the tree counts summaries per directory and marks summarized files', async () => {
    const wrapper = await render();
    const src = wrapper.get('[data-path="src"]');
    expect(src.text()).toContain('已摘要 2 / 3 个文件');
    expect(wrapper.find('[data-path="README.md"]').classes()).not.toContain('summarized');
  });

  test('a truncated repository says so', async () => {
    state.result = { ok: true, data: engineeringMap({ truncated: true }) };
    const wrapper = await render();
    expect(wrapper.get('[data-note="truncated"]').text()).toBe('仓库文件超过 5000 个，只显示前 5000 个');
  });

  test('selecting a module shows its interface and a stale badge', async () => {
    const wrapper = await render();
    expect(wrapper.find('[data-detail]').exists()).toBe(false);
    await wrapper.get('[data-module="src/main/tasks.ts"]').trigger('click');
    const detail = wrapper.get('[data-detail]');
    expect(detail.get('[data-freshness]').text()).toBe('可能过时（文件已改动）');
    expect(detail.get('.map-detail-purpose').text()).toBe('示例数据');
  });

  test('members render in code, dependsOn navigates, and the source opens the requirement', async () => {
    const open = vi.spyOn(useRequirementsStore(), 'open').mockResolvedValue();
    const wrapper = await render();
    await wrapper.get('[data-module="src/main/ipc.ts"]').trigger('click');
    const detail = wrapper.get('[data-detail]');
    expect(detail.get('[data-freshness]').text()).toBe('最新');
    expect(detail.get('.map-member-signature').text()).toBe('(ipcMain: IpcMain) => void');
    expect(detail.get('.map-detail-purpose code').text()).toBe('ipcMain');
    // Only summarized dependencies are links.
    expect(detail.find('[data-depend="electron"]').exists()).toBe(false);
    expect(detail.get('.map-depend-plain').text()).toBe('electron');
    expect(detail.get('[data-source]').text()).toMatch(/^来自需求「邮箱登录」· 2026-01-0\d$/);

    await detail.get('[data-source]').trigger('click');
    expect(open).toHaveBeenCalledWith({ id: 'r1' });

    await detail.get('[data-depend="src/main/tasks.ts"]').trigger('click');
    expect(wrapper.get('.map-detail-path').text()).toBe('src/main/tasks.ts');
    await wrapper.get('[data-action="back"]').trigger('click');
    expect(wrapper.findAll('[data-module]')).toHaveLength(2);
  });

  test('clicking a file in the tree selects its module', async () => {
    const wrapper = await render();
    await wrapper.get('[data-path="src"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-path="src/main"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-path="src/main/ipc.ts"]').trigger('click');
    expect(wrapper.get('.map-detail-path').text()).toBe('src/main/ipc.ts');
  });

  test('conventions and gaps list their source', async () => {
    const open = vi.spyOn(useRequirementsStore(), 'open').mockResolvedValue();
    const wrapper = await render();
    const conventions = wrapper.get('[data-notes="conventions"]');
    expect(conventions.get('.map-note-text code').text()).toBe('node:test');
    await conventions.get('.map-note-source').trigger('click');
    expect(open).toHaveBeenCalledWith({ id: 'r1' });
    expect(wrapper.get('[data-notes="gaps"] .map-note-text').text()).toBe('没有读到 renderer');
  });

  test('errors show the described message, and refresh reloads', async () => {
    state.result = { ok: false, error: { code: 'no_workspace', message: 'x' } };
    const wrapper = await render();
    expect(wrapper.get('[data-error]').text()).toBe('尚未配置工作区，请先在设置里指定仓库路径。 重试');
    expect(wrapper.get('[data-error] .empty-action').text()).toBe('重试');
    state.result = { ok: true, data: engineeringMap() };
    await wrapper.get('[data-action="refresh"]').trigger('click');
    await flushPromises();
    expect(get).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-error]').exists()).toBe(false);
    expect(wrapper.findAll('[data-module]')).toHaveLength(2);
  });

  test('agent text stays text', async () => {
    const injected = '<img src=x onerror=alert(1)>';
    state.result = {
      ok: true,
      data: engineeringMap({
        modules: [
          mapModule({ purpose: injected, members: [{ name: injected, signature: injected }], notes: [injected], source: { ...source, title: injected } }),
        ],
        conventions: [{ text: injected, source }],
      }),
    };
    const wrapper = await render();
    await wrapper.get('[data-module="src/main/ipc.ts"]').trigger('click');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('.map-detail-purpose').text()).toBe(injected);
    expect(wrapper.get('.map-member-name').text()).toBe(injected);
    expect(wrapper.get('[data-source]').text()).toContain(injected);
    expect(wrapper.get('[data-notes="conventions"] .map-note-text').text()).toBe(injected);
  });
});

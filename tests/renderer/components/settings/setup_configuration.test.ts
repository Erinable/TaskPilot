// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import SetupConfiguration from '@/components/settings/SetupConfiguration.vue';
import SetupPage from '@/components/settings/SetupPage.vue';
import { useSetupStore } from '@/stores/setup.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { envState, installApi, ok } from '../../settings_fakes.ts';
import { mountView } from '../../mount_view.ts';
import { ENV_CONFIGURATION } from '../../../main/fixtures/environment.ts';
import type { EnvConfigurationPackage } from '@shared/ipc/environment.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;
const work: EnvConfigurationPackage = { id: 'env-1', title: ENV_CONFIGURATION.title, status: 'pending', needsCommit: false, installPending: false };

beforeEach(() => {
  setActivePinia(createPinia());
  api = installApi();
  const state = envState();
  state.plan!.configuration = ENV_CONFIGURATION;
  useSetupStore().view = state;
});

test('the infrastructure proposal shows checks and the complete reviewable scope before publishing', async () => {
  const wrapper = await mountView(SetupConfiguration);
  expect(wrapper.text()).toContain(ENV_CONFIGURATION.reason);
  expect(wrapper.findAll('.configuration-checks strong').map((node) => node.text())).toEqual(['类型检查', '格式检查']);
  expect(wrapper.findAll('.configuration-files code').map((node) => node.text())).toEqual(ENV_CONFIGURATION.fileScope);
  expect(wrapper.findAll('.configuration-preview ol li').length).toBe(ENV_CONFIGURATION.steps.length);
  expect(wrapper.findAll('.configuration-preview > ul:not(.configuration-files) li').length).toBe(ENV_CONFIGURATION.acceptance.length);
  expect(api.env.createConfiguration).not.toHaveBeenCalled();
  api.env.createConfiguration.mockReturnValue(ok(work));
  await wrapper.get('[data-action="create-configuration"]').trigger('click');
  await flushPromises();
  expect(api.env.createConfiguration).toHaveBeenCalledWith();
  expect(wrapper.find('[data-action="create-configuration"]').exists()).toBe(false);
  expect(wrapper.get('[data-action="open-configuration"]').text()).toContain('打开配置工作包');
  expect(api.env.runStep).not.toHaveBeenCalled();
});

test('an existing package is opened through the execution store rather than claimed or started', async () => {
  useSetupStore().view!.configurationPackage = work;
  const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
  const wrapper = await mountView(SetupConfiguration);
  expect(wrapper.text()).toContain('待领取');
  await wrapper.get('[data-action="open-configuration"]').trigger('click');
  expect(open).toHaveBeenCalledWith(work.id);
  expect(api.env.createConfiguration).not.toHaveBeenCalled();
});

test('a stale proposal cannot publish a configuration package', async () => {
  const setup = useSetupStore();
  setup.view!.stale = true;
  const wrapper = await mountView(SetupConfiguration);
  expect(wrapper.get('[data-action="create-configuration"]').attributes('disabled')).toBeDefined();
  expect(await setup.createConfiguration()).toBe(false);
  expect(api.env.createConfiguration).not.toHaveBeenCalled();
});

test('a completed package leads with saving to git, then refreshing the analysis', async () => {
  const setup = useSetupStore();
  setup.view = envState({ status: 'idle', plan: null, configurationPackage: { ...work, status: 'done', needsCommit: true } });
  const wrapper = await mountView(SetupConfiguration);
  expect(wrapper.get('[data-action="open-configuration"]').text()).toBe('去保存到 git');
  expect(wrapper.text()).toContain('先在执行页保存到 git');
  setup.view.configurationPackage!.needsCommit = false;
  await flushPromises();
  expect(wrapper.text()).toContain('重新分析可读取新增脚本');
  expect(api.env.plan).not.toHaveBeenCalled();
});

test('a reopened configuration shows a runnable fixed install without enabling lifecycle scripts or calling a model', async () => {
  const base = envState();
  const recovered = envState({
    configurationPackage: { ...work, status: 'in_progress', installPending: true },
    plan: { ...base.plan!, scripts: {}, configuration: null },
    stepKinds: [],
    steps: [{ ...base.steps[0], line: 'npm install --ignore-scripts --no-audit --no-fund' }],
  });
  useSetupStore().view = recovered;
  api.env.get.mockReturnValue(ok(recovered));
  api.env.runStep.mockReturnValue(ok(recovered));
  const wrapper = await mountView(SetupPage);
  expect(wrapper.get('#setupSteps').text()).toContain('npm install --ignore-scripts --no-audit --no-fund');
  expect(wrapper.get('#setupAllowScripts').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain('恢复的安装步骤固定关闭安装脚本');
  await wrapper.get('[data-step="install"]').trigger('click');
  await flushPromises();
  expect(api.env.runStep).toHaveBeenCalledWith('install');
  expect(api.env.plan).not.toHaveBeenCalled();
  expect(api.env.setAllowScripts).not.toHaveBeenCalled();
});

test('an applied configuration package asks for local installation before QA', async () => {
  useSetupStore().view!.configurationPackage = { ...work, status: 'in_progress', installPending: true };
  const wrapper = await mountView(SetupConfiguration);
  expect(wrapper.text()).toContain('先运行下面的「安装依赖」');
  expect(wrapper.find('[data-action="create-configuration"]').exists()).toBe(false);
});

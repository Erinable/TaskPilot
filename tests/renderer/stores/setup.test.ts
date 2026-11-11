// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import * as feedback from '@/lib/feedback.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { resultText, useSetupStore } from '@/stores/setup.ts';
import { envState, fail, installApi, ok } from '../settings_fakes.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import type * as envTypes from '@shared/ipc/environment.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  api = installApi();
  setActivePinia(createPinia());
});

afterEach(() => vi.useRealTimers());

const onSetupPage = async () => {
  await useSettingsStore().open('setup');
  const setup = useSetupStore();
  await flushPromises();
  expect(setup.view).not.toBeNull();
  return setup;
};

test('opening the page only reads the session; no step runs on its own', async () => {
  const setup = await onSetupPage();
  expect(api.env.runStep).not.toHaveBeenCalled();
  expect(api.env.plan).not.toHaveBeenCalled();
  expect(setup.statusText).toBe('先安装依赖再跑测试。');
});

test('an existing setup store loads on page entry and reloads when returning from another page', async () => {
  const setup = useSetupStore();
  const settings = useSettingsStore();
  await settings.open('setup');
  await flushPromises();
  expect(setup.view).not.toBeNull();

  settings.openPage('data');
  await settings.open('setup');
  expect(api.env.plan).not.toHaveBeenCalled();
  expect(api.env.runStep).not.toHaveBeenCalled();
});

test('returning to settings reloads setup even when its selected page is unchanged', async () => {
  await onSetupPage();
  await useAppStore().navigate('queue');
  await useSettingsStore().open('setup');
  await flushPromises();
  expect(api.env.get).toHaveBeenCalledTimes(2);
  expect(api.env.plan).not.toHaveBeenCalled();
  expect(api.env.runStep).not.toHaveBeenCalled();
});

test('a step runs by id when clicked', async () => {
  const setup = await onSetupPage();
  expect(await setup.runStep('install')).toBe(true);
  expect(api.env.runStep).toHaveBeenCalledWith('install');
});

test('steps do not run while busy or stale', async () => {
  const setup = await onSetupPage();
  api.env.get.mockReturnValue(ok(envState({ stale: true })));
  await setup.render();
  expect(await setup.runStep('install')).toBe(false);
  api.env.get.mockReturnValue(ok(envState({ running: 'test' })));
  await setup.render();
  expect(await setup.runStep('install')).toBe(false);
  expect(api.env.runStep).not.toHaveBeenCalled();
});

test('allowing install scripts asks first; declining sends nothing', async () => {
  const setup = await onSetupPage();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  expect(await setup.setAllowScripts(true)).toBe(false);
  expect(api.env.setAllowScripts).not.toHaveBeenCalled();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  expect(await setup.setAllowScripts(true)).toBe(true);
  expect(api.env.setAllowScripts).toHaveBeenCalledWith(true);
  // Turning it off needs no confirmation.
  await setup.setAllowScripts(false);
  expect(feedback.confirmAction).toHaveBeenCalledTimes(2);
});

test('a failed step offers a replan with the failure', async () => {
  const setup = await onSetupPage();
  const failed = { line: 'npm ci', ok: false, exitCode: 1, timedOut: false, durationMs: 2500, summary: null, output: 'gyp ERR', at: '' };
  api.env.get.mockReturnValue(
    ok(envState({ steps: [{ id: 'install', kind: 'install', script: null, packages: [], replacesInstall: false, line: 'npm ci', result: failed }] })),
  );
  await setup.render();
  expect(setup.failedStep?.id).toBe('install');
  expect(setup.retryText).toContain('允许依赖的安装脚本');
  await setup.replan();
  expect(api.env.plan).toHaveBeenCalledWith({ withFailure: true });
  expect(resultText(failed)).toBe('失败（退出码 1）· 2.5s');
});

test('a recovered configuration install runs by id without analysis or lifecycle-script permission', async () => {
  const base = envState();
  api.env.get.mockReturnValue(
    ok(
      envState({
        configurationPackage: { id: 'env-1', title: '配置检查', status: 'in_progress', needsCommit: false, installPending: true },
        plan: { ...base.plan!, scripts: {}, configuration: null },
        stepKinds: [],
        facts: { ...base.facts!, installScripts: ['electron'] },
        steps: [{ ...base.steps[0], line: 'npm install --ignore-scripts --no-audit --no-fund' }],
      }),
    ),
  );
  const setup = await onSetupPage();
  expect(setup.ready).toBe(true);
  expect(setup.installationOnly).toBe(true);
  expect(setup.applyItems).toEqual([]);
  expect(setup.notices.some((notice) => notice.text.includes('运行必需的安装脚本'))).toBe(false);
  expect(await setup.setAllowScripts(true)).toBe(false);
  expect(api.env.setAllowScripts).not.toHaveBeenCalled();
  expect(feedback.confirmAction).not.toHaveBeenCalled();
  expect(await setup.runStep('install')).toBe(true);
  expect(api.env.runStep).toHaveBeenCalledWith('install');
  expect(api.env.plan).not.toHaveBeenCalled();
  await setup.plan();
  expect(api.env.plan).toHaveBeenCalledWith();
});

test('a successful unconfigured script is ticked for writing by default', async () => {
  const setup = await onSetupPage();
  const passed = { line: 'npm run test', ok: true, exitCode: 0, timedOut: false, durationMs: 1000, summary: null, output: '', at: '' };
  api.env.get.mockReturnValue(
    ok(envState({ steps: [{ id: 'test', kind: 'test', script: 'test', packages: [], replacesInstall: false, line: 'npm run test', result: passed }] })),
  );
  await setup.render();
  expect(setup.selectedKinds).toEqual(['test']);
  expect(setup.applyItems).toEqual([{ kind: 'test', proposed: 'npm run test', current: '', disabled: false, note: '当前未配置' }]);
});

test('apply with nothing ticked only hints', async () => {
  const setup = await onSetupPage();
  setup.selectedKinds = [];
  expect(await setup.apply()).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('请先勾选要写入的命令。', 'info');
  expect(api.env.apply).not.toHaveBeenCalled();
});

test('a failed action toasts, but a cancelled one stays quiet', async () => {
  expectConsole('error', /IpcError: x/);
  const setup = await onSetupPage();
  api.env.plan.mockReturnValueOnce(fail('agent_failed', 'x'));
  expect(await setup.plan()).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('分析失败：智能体运行失败：x', 'error');
  vi.mocked(feedback.showToast).mockClear();
  api.env.plan.mockReturnValueOnce(fail('agent_cancelled', 'x'));
  await setup.plan();
  expect(feedback.showToast).not.toHaveBeenCalled();
});

test('planning refreshes on environment events and stops after leaving the page', async () => {
  api.env.get.mockReturnValue(ok(envState({ status: 'planning' })));
  const setup = useSetupStore();
  await useSettingsStore().open('setup');
  const calls = api.env.get.mock.calls.length;
  api.emitState({ repositoryId: null, domains: ['environment'] });
  await flushPromises();
  expect(api.env.get.mock.calls.length).toBe(calls + 1);
  expect(setup.statusText).toBe('环境管家正在读取仓库并制定步骤…');
  useSettingsStore().openPage('data');
  api.emitState({ repositoryId: null, domains: ['environment'] });
  await Promise.resolve();
  expect(api.env.get.mock.calls.length).toBe(calls + 1);
});

const withInstallScripts = (overrides: Partial<envTypes.EnvState> = {}) => {
  const base = envState();
  return envState({
    facts: { ...base.facts!, installScripts: ['electron', 'esbuild'] },
    steps: [
      { ...base.steps[0], replacesInstall: true },
      {
        id: 'rebuild',
        kind: 'rebuild',
        script: null,
        packages: ['electron', 'esbuild'],
        replacesInstall: false,
        line: 'npm rebuild electron esbuild',
        result: null,
      },
    ],
    ...overrides,
  });
};

test('packages that need install scripts are named, with the step that runs them', async () => {
  api.env.get.mockReturnValue(ok(withInstallScripts()));
  const setup = await onSetupPage();
  const notice = setup.notices.find((item) => item.text.includes('electron'));
  expect(notice?.tone).toBe('warning');
  expect(notice?.text).toContain('运行必需的安装脚本');
  api.env.get.mockReturnValue(ok(withInstallScripts({ allowScripts: true })));
  await setup.render();
  expect(setup.notices.find((item) => item.text.includes('electron'))?.tone).toBe('info');
});

test('npm ci over an existing install asks first; declining runs nothing', async () => {
  api.env.get.mockReturnValue(ok(withInstallScripts()));
  const setup = await onSetupPage();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  expect(await setup.runStep('install')).toBe(false);
  expect(api.env.runStep).not.toHaveBeenCalled();
  expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].body).toContain('node_modules');
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  expect(await setup.runStep('install')).toBe(true);
  expect(api.env.runStep).toHaveBeenCalledWith('install');
});

test('the rebuild step names its packages before it runs', async () => {
  api.env.get.mockReturnValue(ok(withInstallScripts()));
  const setup = await onSetupPage();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  expect(await setup.runStep('rebuild')).toBe(true);
  expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].body).toContain('electron、esbuild');
  expect(api.env.runStep).toHaveBeenCalledWith('rebuild');
});

test('a repository without setup support says so and offers nothing to apply', async () => {
  api.env.get.mockReturnValue(ok(envState({ blockers: ['setup_unsupported'], facts: null, plan: null, steps: [], stepKinds: [], configured: {} })));
  const setup = await onSetupPage();
  expect(setup.notices.map((item) => item.text)).toEqual([expect.stringContaining('目前只会规划 Node/npm 项目')]);
  expect(setup.facts).toEqual([]);
  expect(setup.applyItems).toEqual([]);
  expect(setup.selectedKinds).toEqual([]);
});

test('a project without a skeleton is told what comes first, as information rather than an error', async () => {
  api.env.get.mockReturnValue(ok(envState({ blockers: ['no_skeleton'], facts: null, plan: null, steps: [], stepKinds: [], configured: {} })));
  const setup = await onSetupPage();
  expect(setup.notices).toEqual([expect.objectContaining({ tone: 'info', text: expect.stringContaining('先写下第一个需求') })]);
});

test('package progress refreshes the linked work package without resetting command selections', async () => {
  const setup = await onSetupPage();
  setup.selectedKinds = ['test'];
  const before = api.env.get.mock.calls.length;
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(api.env.get.mock.calls.length).toBe(before + 1);
  expect(setup.selectedKinds).toEqual(['test']);
});

test('an asynchronous analysis failure shows the CLI reason rather than hiding it behind the code hint', async () => {
  const message = "Codex reported a failed analysis turn: Invalid schema: 'configuration.oneOf' is not permitted when strict is true.";
  api.env.get.mockReturnValue(ok(envState({ status: 'failed', error: { code: 'agent_failed', message } })));
  const setup = await onSetupPage();
  expect(setup.statusText).toContain('分析失败：智能体运行失败：');
  expect(setup.statusText).toContain(message);
});

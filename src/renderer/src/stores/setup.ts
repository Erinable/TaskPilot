// Environment setup page: the Environment Steward proposes, the user confirms
// each step, and the main process runs commands it rebuilds itself. This store
// only ever sends step ids and script kinds.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import type { IpcError } from '@/lib/ipc.ts';
import { ERROR_HINTS, describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import type { IconName } from '@/lib/icons.ts';
import { useAppStore } from './app.ts';
import { useSettingsStore } from './settings.ts';
import type * as ipc from '@shared/ipc_types.ts';

const POLL_MS = 800;

const BLOCKER_TEXT: Record<string, string> = {
  no_manifest: '仓库里没有已提交的 package.json，目前只支持 Node/npm 项目。',
  invalid_manifest: 'package.json 不是合法的 JSON。',
  unsupported_manager: '仓库使用了 npm 以外的包管理器（yarn/pnpm/bun），安装步骤已禁用，脚本仍可运行。',
  node_missing: '在当前 PATH 中找不到 node。可以在「运行环境」里改为从登录 shell 读取 PATH。',
  npm_missing: '在当前 PATH 中找不到 npm。',
};
const adjustmentText = (adjustment: ipc.EnvAdjustment) => {
  if (adjustment.code === 'install_without_manifest') return '没有 package.json，已跳过安装。';
  if (adjustment.code === 'ci_without_lockfile') return '仓库没有 package-lock.json，已把 npm ci 改为 npm install。';
  if (adjustment.code === 'unknown_script') return `package.json 里没有脚本「${adjustment.script}」，已取消 ${adjustment.kind} 步骤。`;
  return (adjustment as { code: string }).code;
};
export const KIND_LABEL: Record<string, string> = { install: '安装依赖', test: '测试', lint: 'Lint', build: 'Build' };

export type SetupNotice = { tone: 'danger' | 'info' | 'warning'; icon: IconName; text: string; detail: string | null };
export type ApplyItem = { kind: ipc.ScriptKind; proposed: string; current: string; disabled: boolean; note: string };

export const resultText = (result: ipc.EnvStepResult) => {
  if (result.timedOut) return '超时';
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.ok) return `成功 · ${seconds}s`;
  return `失败（退出码 ${result.exitCode}）· ${seconds}s`;
};

export const useSetupStore = defineStore('setup', () => {
  // ========== Session ==========
  const view = ref<ipc.EnvState | null>(null);
  const loadError = ref<string | null>(null);
  // A click is waiting on the main process.
  const acting = ref(false);
  // Kinds ticked in the apply list; reset whenever a new view arrives.
  const selectedKinds = ref<ipc.ScriptKind[]>([]);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const busy = computed(() => acting.value || view.value?.status === 'planning' || Boolean(view.value?.running));
  const ready = computed(() => view.value?.status === 'ready');
  const showCancel = computed(() => view.value?.status === 'planning' || Boolean(view.value?.running));
  const planLabel = computed(() => (view.value && view.value.status !== 'idle' ? '重新分析' : '分析环境'));
  const statusWarn = computed(() => view.value?.status === 'failed' || view.value?.stale === true);

  const statusText = computed(() => {
    if (loadError.value) return `读取失败：${loadError.value}`;
    const current = view.value;
    if (!current || current.status === 'idle') return '还没有分析过这个仓库。';
    if (current.status === 'planning') return '环境管家正在读取仓库并制定步骤…';
    if (current.status === 'failed') return `分析失败：${current.error ? ERROR_HINTS[current.error.code] ?? current.error.message : ''}`;
    const parts: string[] = [];
    if (current.stale) parts.push('工作区已切换，这份计划已过期，请重新分析。');
    else if (current.plan) parts.push(current.plan.summary);
    else parts.push('无法制定步骤。');
    if (current.costUsd > 0) parts.push(`（本次分析 $${current.costUsd.toFixed(3)}）`);
    return parts.join(' ');
  });

  // ========== Plan details ==========
  const facts = computed(() => {
    const source = view.value?.facts;
    if (!source) return [];
    return [
      { term: '项目', value: source.manifest?.name ?? (source.manifest ? '（未命名）' : null) },
      { term: '脚本', value: source.manifest ? Object.keys(source.manifest.scripts).join('  ') : null },
      { term: 'Lockfile', value: source.lockfiles.join('  ') },
      { term: 'node_modules', value: source.nodeModules ? '已存在' : '不存在' },
      {
        term: '版本要求',
        value: [
          source.manifest?.engines?.node && `engines.node ${source.manifest.engines.node}`,
          ...source.versionFiles.map((file) => `${file.path} ${file.content}`),
        ].filter(Boolean).join('  '),
      },
      { term: '本机 node / npm', value: `${source.tools.node ?? '未找到'} / ${source.tools.npm ?? '未找到'}` },
      { term: 'CI 配置', value: source.workflows.join('  ') },
    ].map((fact) => ({ term: fact.term, value: fact.value || '—' }));
  });

  const notices = computed(() => {
    const current = view.value;
    if (!current) return [];
    const items: SetupNotice[] = [];
    for (const code of current.blockers) items.push({ tone: 'danger', icon: 'alert', text: BLOCKER_TEXT[code] ?? code, detail: null });
    for (const adjustment of current.plan?.adjustments ?? []) items.push({ tone: 'info', icon: 'info', text: adjustmentText(adjustment), detail: null });
    for (const issue of current.plan?.issues ?? []) items.push({ tone: 'warning', icon: 'alert', text: issue.text, detail: issue.fix || null });
    if (current.plan?.installReason) items.push({ tone: 'info', icon: 'box', text: `安装方式：${current.plan.installReason}`, detail: null });
    return items;
  });

  const failedStep = computed(() => view.value?.steps.find((step) => step.result && !step.result.ok) ?? null);
  const retryText = computed(() => {
    const failed = failedStep.value;
    if (!failed) return '';
    return failed.kind === 'install' && !view.value?.allowScripts
      ? '安装失败了。如果错误来自原生模块编译，可以打开上面的「允许依赖的安装脚本」再试；也可以让环境管家看看输出。'
      : `「${KIND_LABEL[failed.kind]}」失败了。环境管家可以读取输出并给出排查建议。`;
  });

  const applyItems = computed(() => {
    const current = view.value;
    if (!current) return [];
    return (['test', 'lint', 'build'] as const).filter((kind) => current.plan?.scripts[kind]).map((kind): ApplyItem => {
      const proposed = current.steps.find((candidate) => candidate.id === kind)?.line ?? '';
      const configured = current.configured[kind];
      return {
        kind,
        proposed,
        current: configured,
        disabled: busy.value || current.stale || configured === proposed,
        note: configured === proposed ? '已是当前配置' : configured ? `当前：${configured}` : '当前未配置',
      };
    });
  });

  // ========== Actions ==========
  // Every new view resets the apply ticks to their defaults, as a repaint did.
  const setView = (next: ipc.EnvState) => {
    view.value = next;
    selectedKinds.value = (['test', 'lint', 'build'] as const).filter((kind) => {
      const step = next.steps.find((candidate) => candidate.id === kind);
      return Boolean(next.plan?.scripts[kind]) && !next.configured[kind] && step?.result?.ok === true;
    });
  };

  const visible = () => useAppStore().view === 'settings' && useSettingsStore().activePage === 'setup';

  const schedulePoll = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const waiting = view.value && (view.value.status === 'planning' || view.value.running);
    if (waiting && visible()) pollTimer = setTimeout(() => { render().catch((error) => console.error(error)); }, POLL_MS);
  };

  const render = async () => {
    try {
      setView(await call(window.taskpilot.env.get()));
      loadError.value = null;
    } catch (error) {
      console.error(error);
      loadError.value = describeError(error);
      return;
    }
    schedulePoll();
  };

  // Runs an action, takes its returned view, and keeps polling if needed.
  const act = async <T extends ipc.EnvState>(promise: Promise<ipc.IpcResult<T>>, failure = '操作失败') => {
    acting.value = true;
    // Long steps hold the call open; poll meanwhile so "运行中" and Cancel show.
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { render().catch((error) => console.error(error)); }, 200);
    try {
      setView(await call(promise));
      return true;
    } catch (error) {
      console.error(error);
      if ((error as IpcError).code !== 'agent_cancelled') showToast(`${failure}：${describeError(error)}`, 'error');
      return false;
    } finally {
      acting.value = false;
      await render();
    }
  };

  const plan = () => act(window.taskpilot.env.plan(), '分析失败');
  const replan = () => act(window.taskpilot.env.plan({ withFailure: true }), '分析失败');
  const cancel = async () => {
    await window.taskpilot.env.cancel();
    await render();
  };

  // The switch reflects view.allowScripts, so declining leaves it off.
  const setAllowScripts = async (allow: boolean) => {
    if (allow) {
      const confirmed = await confirmAction({
        title: '允许依赖运行安装脚本？',
        body: '依赖包的 preinstall / install / postinstall 脚本会以你的用户权限在本机执行。只在你信任这个仓库的全部依赖时打开。',
        accept: '允许',
        danger: true,
      });
      if (!confirmed) return false;
    }
    return act(window.taskpilot.env.setAllowScripts(allow));
  };

  // Only a step id crosses IPC; the main process rebuilds the command.
  const runStep = async (stepId: ipc.EnvStepId) => {
    if (busy.value || view.value?.stale) return false;
    return act(window.taskpilot.env.runStep(stepId), '运行失败');
  };

  const apply = async () => {
    const kinds = [...selectedKinds.value];
    if (!kinds.length) {
      showToast('请先勾选要写入的命令。', 'info');
      return false;
    }
    const settings = useSettingsStore();
    if (settings.hasUnsavedChanges()) {
      showToast('设置里还有未保存的修改，请先保存或放弃。', 'error');
      return false;
    }
    if (!(await act(window.taskpilot.env.apply(kinds), '写入失败'))) return false;
    await settings.load();
    showToast('验证命令已写入工作区配置。');
    return true;
  };

  return {
    // Session
    view, loadError, acting, selectedKinds, busy, ready, showCancel, planLabel, statusWarn, statusText,
    // Plan details
    facts, notices, failedStep, retryText, applyItems,
    // Actions
    render, plan, replan, cancel, setAllowScripts, runStep, apply,
  };
});

// Settings view: secondary nav, search, one form per page, and a shared save
// bar for unsaved edits. Drafts live here, so they survive leaving the view.
import { defineStore } from 'pinia';
import { computed, nextTick, ref } from 'vue';

import { call, IpcError } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, confirmChoice, showToast } from '@/lib/feedback.ts';
import type { IconName } from '@/lib/icons.ts';
import * as model from '@/lib/settings_model.ts';
import { useAppStore } from './app.ts';
import { useCoursesStore } from './courses.ts';
import { useTasksStore } from './tasks.ts';
import type * as agentRuntimeTypes from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

import { AGENT_IDS } from '@shared/agent_runtime.ts';
import { isStepId } from '@shared/check_steps.ts';
import { useAgentSettings } from './settings_agents.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
export type SettingsPage = model.SettingsPage;

export const MAX_NAME_LENGTH = 40;
export type AgentFieldError = { field: 'cli' | 'model' | 'thinking'; message: string };

export type NavItem = { page: SettingsPage; label: string; icon: IconName; keywords: string };
export type NavGroup = { id: 'personal' | 'workspace' | 'device'; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'personal',
    items: [
      { page: 'profile', label: '个人资料', icon: 'user', keywords: '名字 姓名 头像 颜色 name avatar' },
      { page: 'preferences', label: '偏好设置', icon: 'sliders', keywords: '主题 外观 深色 浅色 毛玻璃 透明 theme dark light vibrancy' },
    ],
  },
  {
    id: 'workspace',
    items: [
      { page: 'repository', label: '仓库', icon: 'folder', keywords: '仓库 路径 目录 git repo root' },
      {
        page: 'commands',
        label: '检查步骤',
        icon: 'terminal',
        keywords: '命令 测试 lint build typecheck format coverage 格式 类型检查 覆盖率 npm test 验证 taskpilot.toml 预设 静态分析',
      },
      { page: 'courses', label: '课程包', icon: 'blocks', keywords: '课程包 course 判卷 维度 rubric 导入 确认 信任 领域 操作系统 编程' },
      { page: 'setup', label: '环境初始化', icon: 'wand', keywords: '环境初始化 环境管家 安装 依赖 npm install ci node_modules setup 配环境' },
    ],
  },
  {
    id: 'device',
    items: [
      { page: 'environment', label: '运行环境', icon: 'cpu', keywords: '环境 PATH shell nvm homebrew 版本 electron node' },
      { page: 'agents', label: '模型与智能体', icon: 'sliders', keywords: 'Agent CLI 模型 thinking 思考强度 claude pi grok codex opencode' },
      { page: 'data', label: '数据', icon: 'database', keywords: '数据 目录 重置 进度 清空 reset' },
    ],
  },
];

// Inputs a validation error can point at, by the error's `field`.
export const FIELD_INPUTS: Record<string, string> = {
  root: 'settingsRoot',
  displayName: 'profileName',
};
// The command input of a step, which its errors point at.
export const stepInputId = (id: string) => `step-${id.replace(':', '-')}-command`;
export const stepStatusId = (id: string) => `step-${id.replace(':', '-')}-status`;
// Which page shows a validation error for a given field.
const FIELD_PAGES: Record<string, SettingsPage> = {
  root: 'repository',
  displayName: 'profile',
  avatarColor: 'profile',
  theme: 'preferences',
  vibrancy: 'preferences',
  pathSource: 'environment',
};

const PATH_ERROR_HINTS: Record<string, string> = {
  shell_timeout: '登录 shell 5 秒内没有响应，已退回继承的 PATH。',
  shell_no_path: '登录 shell 没有输出 PATH，已退回继承的 PATH。',
  unsupported_shell: '不支持你的登录 shell，已退回继承的 PATH。',
  no_shell: '没有找到登录 shell（SHELL 未设置），已退回继承的 PATH。',
};

export type FieldTone = 'ok' | 'warn' | 'error';
export type FieldStatus = { tone: FieldTone | null; message: string };
export type StatusKey = 'root' | 'displayName' | workspaceTypes.CheckKind;
export type WorkspaceDraft = model.WorkspaceDraft;
export type Fact = { term: string; value: string };

// Drafts are reactive proxies, which structuredClone rejects; they are plain JSON.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const emptyStatus = (): FieldStatus => ({ tone: null, message: '' });

// The form shape of a saved workspace: what this machine sets per step.
const workspaceForm = (view: workspaceTypes.WorkspaceView): WorkspaceDraft => ({
  root: view.root ?? '',
  steps: Object.fromEntries(view.steps.map((step) => [step.id, model.stepDraft(step)])),
});

// The form shape of saved preferences, dropping derived fields.
const preferencesForm = (prefs: settingsTypes.Preferences): settingsTypes.PreferencesInput => ({
  profile: { displayName: prefs.profile.displayName, avatarColor: prefs.profile.avatarColor },
  appearance: { ...prefs.appearance },
  environment: { ...prefs.environment },
  agents: clone(prefs.agents),
  // Older main processes send no coding section; sandbox is the default.
  coding: clone(prefs.coding ?? { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 }),
});

export const useSettingsStore = defineStore('settings', () => {
  // ========== Drafts ==========
  // Last saved values, in form shape; null until the first load.
  const savedPreferences = ref<settingsTypes.PreferencesInput | null>(null);
  const savedWorkspace = ref<WorkspaceDraft | null>(null);
  const preferencesDraft = ref<settingsTypes.PreferencesInput | null>(null);
  const workspaceDraft = ref<WorkspaceDraft | null>(null);

  const agentSettings = useAgentSettings(preferencesDraft);
  const {
    agentRuntimes,
    agentRuntimeLoading,
    agentRuntimeError,
    agentConfigNotices,
    agentFieldErrors,
    refreshAgentRuntimes,
    modelCatalogs,
    modelCatalogLoading,
    modelsForAgent,
    modelsLoadingForAgent,
    loadAgentModels,
    setAgentCli,
    setAgentModel,
    setAgentThinking,
    agentStatus,
  } = agentSettings;
  const fillPreferences = (prefs: settingsTypes.PreferencesInput) => {
    preferencesDraft.value = clone(prefs);
    agentFieldErrors.value = {};
    agentConfigNotices.value = {};
  };
  const fillWorkspace = (form: WorkspaceDraft) => {
    workspaceDraft.value = clone(form);
  };

  // ========== Unsaved changes ==========
  const pairs = () =>
    savedPreferences.value && savedWorkspace.value && preferencesDraft.value && workspaceDraft.value
      ? {
          saved: { preferences: savedPreferences.value, workspace: savedWorkspace.value },
          draft: { preferences: preferencesDraft.value, workspace: workspaceDraft.value },
        }
      : null;

  const dirty = computed(() => {
    const pair = pairs();
    return pair ? model.dirtyStores(pair.saved, pair.draft) : { preferences: false, workspace: false };
  });
  // Exactly the nav entries whose page holds an edit.
  const dirtyPages = computed(() => {
    const pair = pairs();
    return pair ? model.dirtyPages(pair.saved, pair.draft) : {};
  });
  const anyDirty = computed(() => dirty.value.preferences || dirty.value.workspace);
  const savebarText = computed(() => {
    const labels: string[] = [];
    if (dirtyPages.value.agents) labels.push('智能体配置');
    if (dirty.value.preferences && (!dirtyPages.value.agents || dirtyPages.value.profile || dirtyPages.value.preferences || dirtyPages.value.environment))
      labels.push('个人与偏好');
    if (dirty.value.workspace) labels.push('工作区');
    return anyDirty.value ? `${labels.join('、')}有未保存的修改` : '';
  });

  const hasUnsavedChanges = () => anyDirty.value;

  // ========== Field status ==========
  const statuses = ref<Record<'root' | 'displayName', FieldStatus> & Partial<Record<workspaceTypes.CheckKind, FieldStatus>>>({
    root: emptyStatus(),
    displayName: emptyStatus(),
  });
  const statusOf = (key: StatusKey) => statuses.value[key] ?? emptyStatus();
  const repoFacts = ref<Fact[] | null>(null);

  const setStatus = (key: StatusKey, tone: FieldTone | null, message: string) => {
    statuses.value[key] = { tone, message };
  };

  const clearWorkspaceStatus = () => {
    setStatus('root', null, '');
    for (const id of Object.keys(workspaceDraft.value?.steps ?? {})) if (isStepId(id)) setStatus(id, null, '');
  };

  // Called on every name edit and after filling the form.
  const nameLength = computed(() => model.charCount(preferencesDraft.value?.profile.displayName));
  const checkNameLength = () => {
    const over = nameLength.value > MAX_NAME_LENGTH;
    setStatus('displayName', over ? 'error' : null, over ? `最多 ${MAX_NAME_LENGTH} 个字符` : '');
  };

  const focusById = (id: string) => nextTick(() => document.getElementById(id)?.focus());

  // A step error names `steps.<id>.<field>`; it goes beside that step.
  // False when `field` is not a step's.
  const showStepError = (field: string | undefined, error: unknown) => {
    const stepId = field?.startsWith('steps.')
      ? field
          .slice('steps.'.length)
          .split('.')[0]
          .replace(/\[\d+\]$/, '')
      : null;
    if (!stepId || !isStepId(stepId)) return false;
    openPage('commands');
    setStatus(stepId, 'error', (error as Error).message);
    focusById(stepInputId(stepId)).catch((focusError) => console.error(focusError));
    return true;
  };

  // Puts a validation error beside its field and opens that field's page.
  const showFieldError = (error: unknown) => {
    console.error(error);
    const field = (error as IpcError).field;
    if (showStepError(field, error)) return;
    if (field === 'agents' || field?.startsWith('agents.')) {
      openPage('agents');
      const modelProblem = field.endsWith('.model') && error instanceof IpcError && error.code === 'invalid_choice';
      const message = modelProblem ? '模型 ID 格式无效，请使用 sonnet 或 provider/model 这类名称（最多 200 字符）。' : describeError(error);
      showToast(`智能体配置无效：${message}`);
      const [, agent, key = 'cli'] = field.split('.');
      if (AGENT_IDS.includes(agent as agentRuntimeTypes.AgentId)) {
        const input = key === 'model' || key === 'thinking' ? key : 'cli';
        agentFieldErrors.value = { ...agentFieldErrors.value, [agent]: { field: input, message } };
        focusById(`agent-${agent}-${input}`).catch((focusError) => console.error(focusError));
      }
      return;
    }
    const page = field ? FIELD_PAGES[field] : undefined;
    if (!field || !page) {
      showToast(`设置无效：${describeError(error)}`);
      return;
    }
    openPage(page);
    const key = field === 'root' || field === 'displayName' ? field : null;
    if (key) setStatus(key, 'error', describeError(error));
    else showToast(`设置无效：${describeError(error)}`);
    if (FIELD_INPUTS[field]) focusById(FIELD_INPUTS[field]).catch((focusError) => console.error(focusError));
  };

  // ========== Repository ==========
  const renderWorkspaceCheck = (result: workspaceTypes.WorkspaceCheck) => {
    clearWorkspaceStatus();
    if (!result.root) {
      setStatus('root', 'warn', '还没有添加仓库，diff 和验证不可用。');
      repoFacts.value = null;
    } else {
      setStatus('root', 'ok', '这是一个 git 仓库');
      const repo = result.repo;
      repoFacts.value = repo
        ? [
            { term: '分支', value: repo.branch ?? 'detached' },
            { term: '当前提交', value: repo.commit.slice(0, 12) },
            { term: '工作区状态', value: repo.dirty ? `${repo.changedFiles} 个文件有改动` : '干净' },
          ]
        : null;
    }
    for (const [id, entry] of Object.entries(result.steps)) {
      if (!isStepId(id) || !entry) continue;
      if (!entry.configured) setStatus(id, null, '未配置，会跳过');
      else if (entry.resolved) setStatus(id, 'ok', entry.resolved);
      else setStatus(id, 'warn', '在当前 PATH 中找不到这个可执行文件。可以改用绝对路径，或在「运行环境」里改为从登录 shell 读取 PATH。');
    }
    tools.value = result.tools;
  };

  const checkWorkspace = async () => {
    if (!workspaceDraft.value) return false;
    clearWorkspaceStatus();
    try {
      renderWorkspaceCheck(await call(window.taskpilot.workspace.check(model.workspaceForm(clone(workspaceDraft.value)))));
      return true;
    } catch (error) {
      showFieldError(error);
      return false;
    }
  };

  // A folder from the native picker, for the sandbox's extra folders; null when dismissed.
  const pickFolder = () => call(window.taskpilot.workspace.pickRoot());

  // ========== Environment ==========
  const environmentLoading = ref(false);
  const environmentError = ref<string | null>(null);
  const environment = ref<settingsTypes.EnvironmentInfo | null>(null);
  // Entries of the inherited PATH, to mark what the login shell added.
  const inheritedEntries = ref<Set<string>>(new Set());

  const renderEnvironment = async ({ refresh = false } = {}) => {
    const source = preferencesDraft.value?.environment.pathSource ?? 'inherit';
    environmentLoading.value = true;
    environmentError.value = null;
    try {
      const [info, inherited] = await Promise.all([
        call(window.taskpilot.environment.info({ source, refresh })),
        source === 'login-shell' ? call(window.taskpilot.environment.info({ source: 'inherit' })) : null,
      ]);
      environment.value = info;
      inheritedEntries.value = new Set(inherited?.entries ?? info.entries);
    } catch (error) {
      console.error(error);
      environmentError.value = describeError(error);
    } finally {
      environmentLoading.value = false;
    }
  };

  const pathNote = computed(() => {
    const info = environment.value;
    if (!info) return { text: '', warn: false };
    if (info.error) return { text: PATH_ERROR_HINTS[info.error.code] ?? `读取失败：${info.error.message}`, warn: true };
    const added = info.entries.filter((entry) => !inheritedEntries.value.has(entry)).length;
    const source = preferencesDraft.value?.environment.pathSource;
    return {
      text: source === 'login-shell' ? `${info.entries.length} 个目录，其中 ${added} 个是登录 shell 新增的` : `${info.entries.length} 个目录`,
      warn: false,
    };
  });

  // ========== Data ==========
  const dataInfo = ref<settingsTypes.DataInfo | null>(null);

  const renderData = async () => {
    try {
      dataInfo.value = await call(window.taskpilot.data.info());
    } catch (error) {
      console.error(error);
      showToast(`读取数据信息失败：${describeError(error)}`);
    }
  };

  const revealData = async () => {
    try {
      await call(window.taskpilot.data.reveal());
    } catch (error) {
      console.error(error);
      showToast(`无法打开目录：${describeError(error)}`);
    }
  };

  const resetProgress = async () => {
    const confirmed = await confirmAction({
      title: '重置工作包进度？',
      body: '所有工作包会回到初始状态：领取记录、基线、步骤进度和偏差记录都会被删除，无法恢复。工作区配置和偏好设置不受影响。',
      accept: '重置进度',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call(window.taskpilot.data.resetProgress());
      await useTasksStore().reloadQueue();
      await renderData();
      showToast('工作包进度已重置。');
    } catch (error) {
      console.error(error);
      showToast(`重置失败：${describeError(error)}`);
    }
  };

  // ========== Check steps ==========
  // The merged steps, taskpilot.toml's state and the recognised languages,
  // as last read from the main process.
  const workspaceView = ref<workspaceTypes.WorkspaceView | null>(null);
  // The preset's tools on PATH, from the last check.
  const tools = ref<workspaceTypes.ToolStatus[]>([]);
  const stepView = (id: workspaceTypes.CheckKind) => workspaceView.value?.steps.find((step) => step.id === id) ?? null;

  // Writes taskpilot.toml naming `preset`, after the user confirms. Local
  // edits are kept; the steps re-merge on top of the new file.
  const createProject = async (preset: string) => {
    const label = workspaceView.value?.presets.find((entry) => entry.id === preset)?.label ?? preset;
    const confirmed = await confirmAction({
      title: '在仓库里创建 taskpilot.toml？',
      body: `会在仓库根目录新建 taskpilot.toml，写入「${label}」预设。它是仓库的文件，要提交到 git 才对其他人生效。没在本机设置的步骤会用预设的默认命令。`,
      accept: '创建',
    });
    if (!confirmed) return;
    try {
      workspaceView.value = await call(window.taskpilot.workspace.createProject(preset));
      const draft = workspaceDraft.value;
      savedWorkspace.value = workspaceForm(workspaceView.value);
      fillWorkspace(draft ? { ...savedWorkspace.value, steps: { ...savedWorkspace.value.steps, ...draft.steps } } : savedWorkspace.value);
      showToast('已创建 taskpilot.toml。');
    } catch (error) {
      console.error(error);
      showToast(`创建失败：${describeError(error)}`);
    }
  };

  // ========== Saving ==========
  const saving = ref(false);
  // Shown beside the workspace group label in the nav.
  const navWorkspaceName = computed(() => {
    const root = savedWorkspace.value?.root;
    return root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? '工作区') : '工作区';
  });

  // Resolves true when everything saved.
  const saveAll = async () => {
    const app = useAppStore();
    const current = dirty.value;
    saving.value = true;
    try {
      if (current.workspace && workspaceDraft.value) {
        // check first, so a failure is shown beside its field before anything is written
        if (!(await checkWorkspace())) return false;
        const view = await call(window.taskpilot.workspace.set(model.workspaceForm(clone(workspaceDraft.value))));
        workspaceView.value = view;
        savedWorkspace.value = workspaceForm(view);
        fillWorkspace(savedWorkspace.value);
        await app.refreshWorkspaceStatus();
      }
      if (current.preferences && preferencesDraft.value) {
        const prefs = await call(window.taskpilot.preferences.set(clone(preferencesDraft.value)));
        savedPreferences.value = preferencesForm(prefs);
        fillPreferences(savedPreferences.value);
        checkNameLength();
        app.applyPreferences(prefs);
        refreshAgentRuntimes().catch((error) => console.error(error));
        if (activePage.value === 'environment') await renderEnvironment();
      }
      showToast('设置已保存。');
      return true;
    } catch (error) {
      showFieldError(error);
      return false;
    } finally {
      saving.value = false;
    }
  };

  const discardAll = () => {
    if (savedPreferences.value) fillPreferences(savedPreferences.value);
    if (savedWorkspace.value) fillWorkspace(savedWorkspace.value);
    agentConfigNotices.value = {};
    checkNameLength();
    clearWorkspaceStatus();
    repoFacts.value = null;
    if (activePage.value === 'environment') renderEnvironment().catch((error) => console.error(error));
  };

  let loadGeneration = 0;
  const load = async () => {
    const token = ++loadGeneration;
    const repositoryId = useRepositoryIdentityStore().currentId;
    try {
      const [prefs, view] = await Promise.all([call(window.taskpilot.preferences.get()), call(window.taskpilot.workspace.get())]);
      if (token !== loadGeneration || repositoryId !== useRepositoryIdentityStore().currentId) return;
      savedPreferences.value = preferencesForm(prefs);
      workspaceView.value = view;
      savedWorkspace.value = workspaceForm(view);
      fillPreferences(savedPreferences.value);
      fillWorkspace(savedWorkspace.value);
      checkNameLength();
      clearWorkspaceStatus();
      repoFacts.value = null;
      if (activePage.value === 'courses') await useCoursesStore().load();
    } catch (error) {
      if (token !== loadGeneration || repositoryId !== useRepositoryIdentityStore().currentId) return;
      console.error(error);
      showToast(`读取设置失败：${describeError(error)}`);
    }
  };

  // ========== Navigation ==========
  const activePage = ref<SettingsPage>('profile');
  const searchQuery = ref('');

  const allItems = NAV_GROUPS.flatMap((group) => group.items);
  const visiblePages = computed(() => new Set(model.matchPages(allItems, searchQuery.value)));
  // A group label hides when none of its pages match.
  const visibleGroups = computed(() => NAV_GROUPS.filter((group) => group.items.some((item) => visiblePages.value.has(item.page))).map((group) => group.id));

  const openPage = (page: string) => {
    if (!model.isSettingsPage(page)) return;
    activePage.value = page;
    if (page === 'agents') refreshAgentRuntimes().catch((error) => console.error(error));
    if (page === 'environment') renderEnvironment().catch((error) => console.error(error));
    if (page === 'data') renderData().catch((error) => console.error(error));
    if (page === 'courses')
      useCoursesStore()
        .load()
        .catch((error) => console.error(error));
  };

  const search = (query: string) => {
    searchQuery.value = query;
    // Keep the open page in sync with what the nav shows.
    const visible = [...visiblePages.value];
    if (visible.length > 0 && !visiblePages.value.has(activePage.value)) openPage(visible[0]);
  };

  // Opens settings, reloading from disk unless there are pending edits.
  const open = async (page: SettingsPage = activePage.value) => {
    if (!(await useAppStore().navigate('settings'))) return;
    if (!hasUnsavedChanges()) await load();
    openPage(page);
    await nextTick();
    document.querySelector<HTMLElement>(`.settings-nav-item[data-page="${page}"]`)?.focus();
  };

  // Leaving settings with unsaved edits: save, discard, or stay (false).
  const confirmLeave = async () => {
    if (!hasUnsavedChanges()) return true;
    const choice = await confirmChoice({ title: '保存修改？', body: '设置里有未保存的修改。离开后这些修改会丢失。', accept: '保存', alternate: '不保存' });
    if (choice === 'accept') return saveAll();
    if (choice === 'alternate') {
      discardAll();
      return true;
    }
    return false;
  };
  useAppStore().setLeaveGuard(confirmLeave);

  return {
    // Drafts
    savedPreferences,
    savedWorkspace,
    preferencesDraft,
    workspaceDraft,
    agentRuntimes,
    agentRuntimeLoading,
    agentRuntimeError,
    agentConfigNotices,
    agentFieldErrors,
    refreshAgentRuntimes,
    modelCatalogs,
    modelCatalogLoading,
    modelsForAgent,
    modelsLoadingForAgent,
    loadAgentModels,
    setAgentCli,
    setAgentModel,
    setAgentThinking,
    agentStatus,
    // Unsaved changes
    dirty,
    dirtyPages,
    anyDirty,
    savebarText,
    hasUnsavedChanges,
    // Field status
    statuses,
    statusOf,
    repoFacts,
    nameLength,
    checkNameLength,
    // Repository
    checkWorkspace,
    pickFolder,
    // Check steps
    workspaceView,
    tools,
    stepView,
    createProject,
    // Environment
    environmentLoading,
    environmentError,
    environment,
    inheritedEntries,
    pathNote,
    renderEnvironment,
    // Data
    dataInfo,
    renderData,
    revealData,
    resetProgress,
    // Saving
    saving,
    navWorkspaceName,
    saveAll,
    discardAll,
    load,
    // Navigation
    activePage,
    searchQuery,
    visiblePages,
    visibleGroups,
    openPage,
    search,
    open,
    confirmLeave,
  };
});

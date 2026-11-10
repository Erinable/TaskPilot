// The getting-started checklist follows the user's goal and the configured
// runtimes. Coding is optional; learning creates its lab repository later.
import type * as agentRuntimeTypes from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { IconName } from './icons.ts';

export type OnboardingPath = 'project' | 'course';
export type OnboardingStepId = 'cli' | 'coding' | 'repository' | 'checks' | 'requirement';

export const SIGN_IN_COMMANDS: Record<agentRuntimeTypes.CliId, string> = {
  claude: 'claude',
  codex: 'codex login',
  pi: 'pi',
  grok: 'grok login',
  opencode: 'opencode auth login',
};
export const INSTALL_COMMANDS: Record<agentRuntimeTypes.CliId, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  pi: 'npm install -g @earendil-works/pi-coding-agent',
  grok: 'npm install -g @xai-official/grok',
  opencode: 'npm install -g opencode-ai',
};
const CLI_NAMES: Record<agentRuntimeTypes.CliId, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', grok: 'Grok', opencode: 'OpenCode' };

export type OnboardingFacts = {
  agent: settingsTypes.AgentStatus | null;
  workspace: workspaceTypes.WorkspaceInfo | null;
  // Null until the effective workspace steps have been read.
  checksReady: boolean | null;
  requirementCount: number;
  courseRequirementCount?: number;
  path?: OnboardingPath;
};

export type CliHelp = { role: string; title: string; detail: string; ready: boolean; commands: string[] };
export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  why: string;
  icon: IconName;
  done: boolean;
  waiting: boolean;
  action: string;
  optional?: boolean;
  command?: string;
  help?: CliHelp[];
};

// A configured blocking submission check prepares a repository for review.
// This includes lab custom:grade and excludes disabled or advisory steps.
export const hasBlockingChecks = (steps: workspaceTypes.StepView[]): boolean =>
  steps.some(
    (step) =>
      step.skipped === null &&
      step.effective?.stage === 'submit' &&
      step.effective.blocking &&
      step.effective.lines.length > 0 &&
      step.effective.lines.every((line) => Boolean(line.trim())),
  );

const signedOut = (signIn: settingsTypes.CliSignIn | null | undefined) => signIn?.state === 'signed_out';
const roleHelp = (role: string, status: settingsTypes.AgentCliStatus): CliHelp => {
  const name = CLI_NAMES[status.cli];
  if (!status.installed)
    return {
      role,
      title: `安装并登录 ${name}`,
      detail: `${role} 使用 ${name}，当前 PATH 中没有找到它。安装后运行登录命令；已安装的话，检查「运行环境」的 PATH 来源。`,
      ready: false,
      commands: [INSTALL_COMMANDS[status.cli], SIGN_IN_COMMANDS[status.cli]],
    };
  if (signedOut(status.signIn))
    return {
      role,
      title: `登录 ${name}`,
      detail: `${role} 使用的 ${name} 已安装，但还没有登录。登录后回来重新检查。`,
      ready: false,
      commands: [SIGN_IN_COMMANDS[status.cli]],
    };
  if (!status.available)
    return {
      role,
      title: `检查 ${name} 的运行配置`,
      detail: `${role} 使用的 ${name} 已安装，但尚不能运行。${status.reason ?? '到「模型与智能体」检查 CLI 版本和配置，或选择兼容的 CLI。'}`,
      ready: false,
      commands: [],
    };
  return {
    role,
    title: `${name} 已就绪`,
    detail: `${role} 使用 ${name}${status.signIn?.state === 'unknown' ? '，无法离线确认登录，将在首次调用时验证' : '，已登录'}。`,
    ready: true,
    commands: [],
  };
};

const cliStep = (agent: settingsTypes.AgentStatus | null, path: OnboardingPath): OnboardingStep => {
  const help = agent
    ? path === 'course'
      ? [roleHelp('Tutor', agent.tutor)]
      : [roleHelp('Product Lead', agent.analysis['product-lead']), roleHelp('Architect', agent.analysis.architect)]
    : [];
  const pending = help.filter((entry) => !entry.ready);
  const done = help.length > 0 && pending.length === 0;
  return {
    id: 'cli',
    title: done ? `${path === 'course' ? 'Tutor' : '规划'} CLI 已就绪` : (pending[0]?.title ?? '检查 AI 团队的 CLI'),
    why: help.length ? help.map((entry) => `${entry.role}：${entry.title}`).join('；') : '正在读取所选角色的 CLI 配置。',
    icon: 'terminal',
    done,
    waiting: false,
    action: '查看配置帮助',
    command: pending[0]?.commands[0],
    help,
  };
};

const codingStep = (agent: settingsTypes.AgentStatus | null): OnboardingStep => {
  const coding = agent?.coding;
  const cli = coding?.cli ?? 'codex';
  const name = CLI_NAMES[cli];
  const done = coding?.installed === true && !signedOut(coding.signIn);
  const signIn = coding?.installed === true;
  return {
    id: 'coding',
    title: signIn ? `登录 ${name}（可选）` : `安装 ${name}（可选）`,
    why: done
      ? `Coding Agent 会用 ${name} 写代码。`
      : signIn
        ? `Coding Agent 用 ${name} 写代码，它已经装好但还没登录。不想让 AI 写代码可以跳过，自己写也行。`
        : `Coding Agent 用 ${name} 写代码。不装也能用 TaskPilot，代码由你自己写；也可以在设置里换成已经装好的 CLI。`,
    icon: 'bot',
    done,
    waiting: false,
    action: signIn ? '查看登录方法' : '查看安装方法',
    optional: true,
    command: signIn ? SIGN_IN_COMMANDS[cli] : INSTALL_COMMANDS[cli],
  };
};

export const buildSteps = (facts: OnboardingFacts): OnboardingStep[] => {
  const path = facts.path ?? 'project';
  const cli = cliStep(facts.agent, path);
  if (path === 'course')
    return [
      cli,
      {
        id: 'requirement',
        title: '告诉 Tutor 你想学什么',
        why: '选择基础、目标和实验工具链，Tutor 会规划学习路径。生成第一个 lab 时再选择文件夹，项目和检查配置会一并准备好。',
        icon: 'sparkle',
        done: (facts.courseRequirementCount ?? 0) > 0,
        waiting: !cli.done,
        action: '我想学…',
      },
    ];
  const repository = facts.workspace?.configured === true;
  return [
    cli,
    codingStep(facts.agent),
    {
      id: 'repository',
      title: '添加你的项目',
      why: '选择项目所在的文件夹。它需要是一个 git 仓库，TaskPilot 用它来比较你改了哪些文件。',
      icon: 'folder',
      done: repository,
      waiting: false,
      action: '选择文件夹',
    },
    {
      id: 'checks',
      title: '设置自动检查',
      why: '配置至少一项提交时运行的阻塞检查，例如构建、测试或 lab 的评分检查，TaskPilot 会在审查前执行。',
      icon: 'flask',
      done: facts.checksReady === true,
      waiting: !repository,
      action: '设置检查步骤',
    },
    {
      id: 'requirement',
      title: '写下第一个需求',
      why: '用大白话描述你想做的功能，Product Lead 会问清细节，再拆成一步步能照着做的任务。',
      icon: 'sparkle',
      done: facts.requirementCount > 0,
      waiting: !cli.done || !repository,
      action: '写需求',
    },
  ];
};

export const isComplete = (steps: OnboardingStep[]) => steps.every((step) => step.done || step.optional);

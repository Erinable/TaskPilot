// The getting-started checklist on the queue page: what a new user must do
// before the AI team can work, in the order the steps depend on each other.
// Every step is derived from state TaskPilot already has. The coding CLI is
// optional: without it the user writes the code, so it never blocks a step.
import type * as agentRuntimeTypes from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { IconName } from './icons.ts';

export type OnboardingStepId = 'cli' | 'coding' | 'repository' | 'checks' | 'requirement';

// Commands to show; the CLI itself does the sign-in.
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
  // Null until agent:status answers.
  agent: settingsTypes.AgentStatus | null;
  workspace: workspaceTypes.WorkspaceInfo | null;
  // Null until workspace:get answers.
  testCommand: string | null;
  requirementCount: number;
};

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  // Plain words: what it is and why it matters.
  why: string;
  icon: IconName;
  done: boolean;
  // The step before it is not done yet.
  waiting: boolean;
  action: string;
  // Not required; shown but never counted against the checklist.
  optional?: boolean;
  // The terminal command that does this step, when there is one.
  command?: string;
};

// "signed out" only when the CLI said so; unknown is given the benefit of the doubt.
const signedOut = (signIn: settingsTypes.CliSignIn | null | undefined) => signIn?.state === 'signed_out';

const cliStep = (agent: settingsTypes.AgentStatus | null): OnboardingStep => {
  const installed = agent?.available === true;
  if (installed && signedOut(agent?.signIn))
    return {
      id: 'cli',
      title: '登录 Claude Code',
      why: 'Claude Code 已经装好，但还没登录。在终端运行下面的命令，按提示登录；用 API key 的话，设好 ANTHROPIC_API_KEY 也可以。登录后点右上角重新检查。',
      icon: 'terminal',
      done: false,
      waiting: false,
      action: '查看登录方法',
      command: SIGN_IN_COMMANDS.claude,
    };
  return {
    id: 'cli',
    title: '安装并登录 Claude Code',
    why: 'AI 团队通过它来读需求、拆任务、检查改动。装好后在终端运行一次 claude 完成登录。',
    icon: 'terminal',
    done: installed,
    waiting: false,
    action: '查看安装方法',
    command: INSTALL_COMMANDS.claude,
  };
};

// Optional: lets the Coding Agent write the code.
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
  const cliReady = facts.agent?.available === true && !signedOut(facts.agent?.signIn);
  const repository = facts.workspace?.configured === true;
  const checks = Boolean(facts.testCommand?.trim());
  const requirement = facts.requirementCount > 0;
  return [
    cliStep(facts.agent),
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
      why: '环境管家会读你的项目，推荐运行测试的命令。提交前 TaskPilot 会自动跑一遍，帮你发现问题。',
      icon: 'flask',
      done: checks,
      waiting: !repository,
      action: '让环境管家分析',
    },
    {
      id: 'requirement',
      title: '写下第一个需求',
      why: '用大白话描述你想做的功能，Product Lead 会问清细节，再拆成一步步能照着做的任务。',
      icon: 'sparkle',
      done: requirement,
      waiting: !cliReady || !repository,
      action: '写需求',
    },
  ];
};

// Shown until every required step is done.
export const isComplete = (steps: OnboardingStep[]) => steps.every((step) => step.done || step.optional);

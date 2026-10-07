// The getting-started checklist on the queue page: the four things a new
// user must do before the AI team can work, in the order they depend on each
// other. Every step is derived from state TaskPilot already has.
import type * as ipc from '@shared/ipc_types.ts';
import type { IconName } from './icons.ts';

export type OnboardingStepId = 'cli' | 'repository' | 'checks' | 'requirement';

export type OnboardingFacts = {
  // Null until agent:status answers.
  agent: ipc.AgentStatus | null;
  workspace: ipc.WorkspaceInfo | null;
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
};

export const buildSteps = (facts: OnboardingFacts): OnboardingStep[] => {
  const cli = facts.agent?.available === true;
  const repository = facts.workspace?.configured === true;
  const checks = Boolean(facts.testCommand?.trim());
  const requirement = facts.requirementCount > 0;
  return [
    {
      id: 'cli',
      title: '安装 Claude Code',
      why: 'AI 团队通过它来读需求、拆任务、检查你的代码。装好后在终端运行一次 claude 完成登录。',
      icon: 'terminal',
      done: cli,
      waiting: false,
      action: '查看安装方法',
    },
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
      waiting: !cli || !repository,
      action: '写需求',
    },
  ];
};

// Shown until every step is done.
export const isComplete = (steps: OnboardingStep[]) => steps.every((step) => step.done);

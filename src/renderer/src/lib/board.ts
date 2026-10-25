// The queue as a board: one column per stage of a package's life, and the
// one thing to do next on each card. Cards only offer buttons; moving a
// package always goes through its real transition (claim records a
// baseline, submit starts QA), so the board never drags.
//
// [人工决策-2026-10-14] 看板不支持拖动；每张卡片只放一个这一列最该做的操作。
import { ACCURATE_RANGE, OVERRUN_RATIO, actualHours, plannedHours } from '@shared/estimate.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

export type ColumnId = 'todo' | 'doing' | 'review' | 'accept' | 'done';

export const COLUMNS: { id: ColumnId; label: string; hint: string }[] = [
  { id: 'todo', label: '待执行', hint: '可以开始的工作包' },
  { id: 'doing', label: '执行中', hint: '你正在写的代码' },
  { id: 'review', label: '待审查', hint: 'QA 正在审查' },
  { id: 'accept', label: '待验收', hint: '等你确认结果' },
  { id: 'done', label: '已完成', hint: '已经验收' },
];

// Deviation and blocked stay with the developer's work, marked on the card.
const COLUMN_OF: Record<packageTypes.WorkPackageStatus, ColumnId> = {
  clarifying: 'todo',
  pending: 'todo',
  in_progress: 'doing',
  deviation: 'doing',
  blocked: 'doing',
  in_review: 'review',
  accepting: 'accept',
  done: 'done',
};

export const columnOf = (task: Pick<packageTypes.TaskView, 'status'>): ColumnId => COLUMN_OF[task.status] ?? 'todo';

// What a card's one button does. `wait` means there is nothing to do yet.
export type CardAction = { kind: 'claim' | 'open' | 'accept'; label: string } | { kind: 'wait'; label: string };

export const actionOf = (task: Pick<packageTypes.TaskView, 'status' | 'dependencies' | 'humanTransitions'>): CardAction => {
  switch (task.status) {
    case 'pending':
      if ((task.dependencies ?? []).some((dependency) => dependency.blocking)) return { kind: 'wait', label: '等待前置' };
      return (task.humanTransitions ?? []).includes('claim') ? { kind: 'claim', label: '开始执行' } : { kind: 'open', label: '查看' };
    case 'clarifying':
      return { kind: 'wait', label: 'Product Lead 拆解中' };
    case 'in_progress':
      return { kind: 'open', label: '继续' };
    case 'deviation':
      return { kind: 'wait', label: 'Architect 裁决中' };
    case 'blocked':
      return { kind: 'open', label: '处理阻塞' };
    case 'in_review':
      return { kind: 'wait', label: 'QA 审查中' };
    case 'accepting':
      return { kind: 'accept', label: '去验收' };
    case 'done':
      return { kind: 'open', label: '查看' };
  }
};

// Small labels on a card besides its status.
export type CardFlag = { tone: 'warning' | 'danger' | 'info'; text: string };

export const flagsOf = (task: packageTypes.TaskView): CardFlag[] => {
  const flags: CardFlag[] = [];
  const blocking = (task.dependencies ?? []).filter((dependency) => dependency.blocking);
  if (task.status === 'pending' && blocking.length)
    flags.push({ tone: 'info', text: `等待：${blocking.map((dependency) => dependency.title ?? dependency.id).join('、')}` });
  if (task.status === 'deviation') flags.push({ tone: 'warning', text: '已报告偏差' });
  if (task.status === 'blocked') flags.push({ tone: 'danger', text: '已阻塞' });
  if (task.review?.status === 'rejected' && task.status === 'in_progress') flags.push({ tone: 'warning', text: 'QA 退回修改' });
  if (task.codingRun && ['preparing', 'running', 'checking', 'applying', 'verifying'].includes(task.codingRun.status)) {
    flags.push({ tone: 'info', text: `Coding Agent 第 ${task.codingRun.attempt} 轮` });
  }
  return flags;
};

// Groups the queue into columns, keeping the queue's order inside each.
export const groupByColumn = (tasks: packageTypes.TaskView[]): Record<ColumnId, packageTypes.TaskView[]> => {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column.id, [] as packageTypes.TaskView[]])) as Record<ColumnId, packageTypes.TaskView[]>;
  for (const task of tasks) columns[columnOf(task)].push(task);
  return columns;
};

// "预计 2h · 实际 2.5h", and whether it ran over by more than half.
export const timeText = (task: packageTypes.TaskView): { text: string; overrun: boolean } | null => {
  const planned = plannedHours(task);
  const actual = actualHours(task);
  if (actual === null) return null;
  const hours = (value: number) => (value < 1 ? `${Math.max(1, Math.round(value * 60))} 分钟` : `${Math.round(value * 10) / 10}h`);
  return {
    text: planned === null ? `实际 ${hours(actual)}` : `预计 ${hours(planned)} · 实际 ${hours(actual)}`,
    overrun: planned !== null && actual > planned * OVERRUN_RATIO,
  };
};

// Share of finished packages that took between half and one-and-a-half
// times their estimate; null without any finished package with both.
export const estimateAccuracy = (tasks: packageTypes.TaskView[]): { ratio: number; count: number } | null => {
  const pairs = tasks.flatMap((task) => {
    const planned = plannedHours(task);
    const actual = actualHours(task);
    return planned && actual !== null ? [actual / planned] : [];
  });
  if (!pairs.length) return null;
  const accurate = pairs.filter((ratio) => ratio >= ACCURATE_RANGE[0] && ratio <= ACCURATE_RANGE[1]).length;
  return { ratio: accurate / pairs.length, count: pairs.length };
};

// Packages the developer is working on right now, for the one-at-a-time hint.
export const inProgressCount = (tasks: packageTypes.TaskView[]) => tasks.filter((task) => task.status === 'in_progress').length;

export type QueueLayout = 'board' | 'list';
export const LAYOUT_STORAGE_KEY = 'taskpilot.queueLayout';

// [人工决策-2026-10-14] 首页默认看板，可切换列表并记住选择。
export const readLayout = (storage: Pick<Storage, 'getItem'> | undefined): QueueLayout => (storage?.getItem(LAYOUT_STORAGE_KEY) === 'list' ? 'list' : 'board');

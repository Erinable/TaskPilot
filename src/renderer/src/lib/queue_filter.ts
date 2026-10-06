// The queue's status filter and ordering.
import type * as ipc from '@shared/ipc_types.ts';

export type QueueFilter = 'active' | 'mine' | 'waiting' | 'done' | 'all';

// 'mine' is what the human can act on now; 'waiting' is with the agents.
const FILTER_STATUSES: Record<Exclude<QueueFilter, 'all'>, ipc.WorkPackageStatus[]> = {
  active: ['pending', 'in_progress', 'accepting', 'blocked', 'clarifying', 'in_review', 'deviation'],
  mine: ['pending', 'in_progress', 'accepting', 'blocked'],
  waiting: ['clarifying', 'in_review', 'deviation'],
  done: ['done'],
};

export const FILTER_OPTIONS: { value: QueueFilter; label: string }[] = [
  { value: 'active', label: '未完成' },
  { value: 'mine', label: '待我处理' },
  { value: 'waiting', label: '等 AI 处理' },
  { value: 'done', label: '已完成' },
  { value: 'all', label: '全部状态' },
];

const PRIORITY_ORDER: Record<ipc.Priority, number> = { high: 0, medium: 1, low: 2 };

// Matches the panel's "按优先级排序": priority, then the queue's own order
// (newest generated packages first).
export const filterQueue = (tasks: ipc.TaskView[], filter: QueueFilter) => tasks
  .map((task, index) => ({ task, index }))
  .filter(({ task }) => filter === 'all' || FILTER_STATUSES[filter].includes(task.status))
  .sort((a, b) => PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] || a.index - b.index)
  .map(({ task }) => task);

export const countByFilter = (tasks: ipc.TaskView[]) => Object.fromEntries(FILTER_OPTIONS.map(({ value }) => [value, filterQueue(tasks, value).length])) as Record<QueueFilter, number>;

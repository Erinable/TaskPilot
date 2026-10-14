// Planned and actual hours of a work package, for the queue and the board.
import type { TaskView } from './ipc_types.ts';

// The hours in a "预计 2 小时" / "预计 30 分钟" estimate, for packages saved
// before the number was kept; null when the text is something else.
export const parseEstimate = (estimate: string): number | null => {
  const match = /^预计\s*(\d+(?:\.\d+)?)\s*(小时|分钟)$/.exec(estimate.trim());
  if (!match) return null;
  return match[2] === '分钟' ? Number(match[1]) / 60 : Number(match[1]);
};

export const plannedHours = (task: Pick<TaskView, 'estimate' | 'estimateHours'>): number | null => task.estimateHours ?? parseEstimate(task.estimate);

// Wall-clock hours from claim to done, breaks included; null until done.
export const actualHours = (task: Pick<TaskView, 'claimedAt' | 'completedAt'>): number | null => {
  if (!task.claimedAt || !task.completedAt) return null;
  const hours = (Date.parse(task.completedAt) - Date.parse(task.claimedAt)) / 3_600_000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
};

// Over the estimate by more than half: worth a second look.
export const OVERRUN_RATIO = 1.5;
// Within half to one-and-a-half times the estimate counts as accurate.
export const ACCURATE_RANGE: [number, number] = [0.5, 1.5];

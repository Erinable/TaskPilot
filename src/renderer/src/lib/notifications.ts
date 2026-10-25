// Notifications are the things waiting on the human, derived from the current
// work packages and requirements (not from the activity log). Each id changes
// when the underlying event changes, so a new event shows as unread again.
import { rowTitle } from '@/components/requirements/requirement_model.ts';
import { describeErrorInfo } from './errors.ts';
import type * as envelopeTypes from '@shared/ipc/envelope.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

export const MAX_NOTIFICATIONS = 50;

export type NotificationTarget = { kind: 'package'; id: string } | { kind: 'requirement'; id: string };

export type NotificationItem = {
  id: string;
  title: string;
  text: string;
  // Null when the state carries no time (a blocked package).
  at: string | null;
  tone: 'attention' | 'danger' | 'info';
  target: NotificationTarget;
};

const cancelled = (error: envelopeTypes.ErrorInfo) => error.code === 'agent_cancelled';

const DECISION_TEXT: Record<packageTypes.DeviationResolution['decision'], string> = {
  dismiss: 'Architect 已裁决（驳回）',
  replan: 'Architect 已裁决（重新规划）',
};

type TaskNotification = (key: string, text: string, at: string | null, tone: NotificationItem['tone']) => NotificationItem;

const failedAgentNotification = (
  run: packageTypes.TaskView['review'] | packageTypes.TaskView['adjudication'],
  kind: string,
  label: string,
  item: TaskNotification,
): NotificationItem[] => {
  if (run?.status !== 'failed' || cancelled(run.error)) return [];
  const at = run.finishedAt ?? run.startedAt;
  return [item(`${kind}-failed:${at}`, `${label}：${describeErrorInfo(run.error)}`, at, 'danger')];
};

const fromTask = (task: packageTypes.TaskView): NotificationItem[] => {
  const target: NotificationTarget = { kind: 'package', id: task.id };
  const item = (key: string, text: string, at: string | null, tone: NotificationItem['tone']): NotificationItem => ({
    id: `${task.id}:${key}`,
    title: task.title,
    text,
    at,
    tone,
    target,
  });
  const items: NotificationItem[] = [];
  const { review, adjudication } = task;
  if (task.status === 'accepting') items.push(item(`accepting:${review?.finishedAt ?? ''}`, '待你验收', review?.finishedAt ?? null, 'attention'));
  if (task.status === 'blocked') items.push(item('blocked', '已标记阻塞', null, 'danger'));
  // A finished package needs nothing more from its last review or ruling.
  if (task.status === 'done') return items;
  if (review?.status === 'rejected' && task.status === 'in_progress')
    items.push(item(`review:${review.finishedAt}`, 'QA 退回了修改', review.finishedAt, 'danger'));
  items.push(...failedAgentNotification(review, 'review', 'QA 审查没有完成', item));
  items.push(...failedAgentNotification(adjudication, 'adjudication', '裁决没有完成', item));
  const resolution = task.deviations[task.deviations.length - 1]?.resolution;
  if (adjudication?.status === 'done' && resolution && !resolution.reverted) {
    const at = adjudication.finishedAt ?? resolution.decidedAt;
    items.push(item(`adjudication:${at}`, DECISION_TEXT[resolution.decision], at, 'info'));
  }
  return items;
};

const fromRequirement = (requirement: requirementTypes.Requirement): NotificationItem[] => {
  const item = (text: string, tone: NotificationItem['tone']): NotificationItem[] => [
    {
      id: `${requirement.id}:${requirement.status}:${requirement.updatedAt}`,
      title: rowTitle(requirement) || '未命名需求',
      text,
      at: requirement.updatedAt,
      tone,
      target: { kind: 'requirement', id: requirement.id },
    },
  ];
  if (requirement.status === 'answering') return item('Product Lead 等你回答问题', 'attention');
  if (requirement.status === 'reviewing') return item('拆解完成，等你确认发布', 'attention');
  if (requirement.status === 'failed' && requirement.error?.code !== 'agent_cancelled')
    return item(`运行失败：${describeErrorInfo(requirement.error)}`, 'danger');
  return [];
};

const time = (item: NotificationItem) => (item.at ? Date.parse(item.at) : -Infinity);

// Every current notification, newest first (untimed last). The list shows the
// first MAX_NOTIFICATIONS; read state is pruned against all of them.
export const deriveNotifications = (tasks: packageTypes.TaskView[], requirements: requirementTypes.Requirement[]): NotificationItem[] =>
  [...tasks.flatMap(fromTask), ...requirements.flatMap(fromRequirement)].sort((left, right) => time(right) - time(left) || left.id.localeCompare(right.id));

// Read ids that still name a notification, so the stored set stays bounded.
export const pruneRead = (read: Iterable<string>, items: NotificationItem[]) => {
  const live = new Set(items.map((item) => item.id));
  return [...read].filter((id) => live.has(id));
};

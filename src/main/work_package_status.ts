// Work package lifecycle. Transitions are explicit so the renderer can derive
// which actions to offer, and so an agent can never move a package through a
// step that belongs to the human (or the reverse).
export const STATUSES = {
  clarifying: { label: '澄清中', humanActionable: false },
  pending: { label: '待执行', humanActionable: true },
  in_progress: { label: '执行中', humanActionable: true },
  in_review: { label: '待审查', humanActionable: false },
  deviation: { label: '偏差待裁决', humanActionable: false },
  accepting: { label: '待验收', humanActionable: true },
  done: { label: '已完成', humanActionable: false },
  blocked: { label: '已阻塞', humanActionable: true },
};

// A work package's lifecycle status.
export type WorkPackageStatus = keyof typeof STATUSES;

// Who triggers a transition. Coding Agent owns only coding_submitted; the
// distinct actor prevents accidental reuse of human or analysis-agent authority.
export type Actor = 'human' | 'agent' | 'coding-agent';

export type TransitionName =
  | 'breakdown_done'
  | 'claim'
  | 'revert_replan'
  | 'release'
  | 'submit_for_review'
  | 'coding_submitted'
  | 'report_deviation'
  | 'override_dismissal'
  | 'block'
  | 'review_accepted'
  | 'review_passed'
  | 'review_rejected'
  | 'replanned'
  | 'deviation_dismissed'
  | 'accepted'
  | 'acceptance_rejected'
  | 'unblock';

export interface Transition {
  from: WorkPackageStatus;
  to: WorkPackageStatus;
  actor: Actor;
  name: TransitionName;
}

export type TransitionErrorCode = 'unknown_status' | 'not_allowed' | 'wrong_actor';

// actor: who is allowed to trigger it. 'human' is the developer at the
// keyboard, 'agent' is one of the AI team members.
//
// [人工决策-2026-10-05 21:57:41] 流程全自动：QA 通过且没有「需要人工确认」项时直接 done
// （review_accepted）；有确认项才停在 accepting 等人验收。偏差由 Architect 自动裁决并生效，
// 人保留两个撤销入口：override_dismissal（不同意驳回，要求重规划）和 revert_replan（撤销重规划）。
// [人工决策-2026-10-12 15:08:39] 编码闭环全自动：补丁应用、提交前检查通过后，Coding Agent 自己提交审查
// （coding_submitted），人工的 submit_for_review 保留。这是 Coding Agent 唯一能触发的业务流转。
export const TRANSITIONS: Transition[] = [
  { from: 'clarifying', to: 'pending', actor: 'agent', name: 'breakdown_done' },
  { from: 'pending', to: 'in_progress', actor: 'human', name: 'claim' },
  { from: 'pending', to: 'in_progress', actor: 'human', name: 'revert_replan' },
  { from: 'in_progress', to: 'pending', actor: 'human', name: 'release' },
  { from: 'in_progress', to: 'in_review', actor: 'human', name: 'submit_for_review' },
  { from: 'in_progress', to: 'in_review', actor: 'coding-agent', name: 'coding_submitted' },
  { from: 'in_progress', to: 'deviation', actor: 'human', name: 'report_deviation' },
  { from: 'in_progress', to: 'deviation', actor: 'human', name: 'override_dismissal' },
  { from: 'in_progress', to: 'blocked', actor: 'human', name: 'block' },
  { from: 'in_review', to: 'done', actor: 'agent', name: 'review_accepted' },
  { from: 'in_review', to: 'accepting', actor: 'agent', name: 'review_passed' },
  { from: 'in_review', to: 'in_progress', actor: 'agent', name: 'review_rejected' },
  { from: 'deviation', to: 'pending', actor: 'agent', name: 'replanned' },
  { from: 'deviation', to: 'in_progress', actor: 'agent', name: 'deviation_dismissed' },
  { from: 'accepting', to: 'done', actor: 'human', name: 'accepted' },
  { from: 'accepting', to: 'in_progress', actor: 'human', name: 'acceptance_rejected' },
  { from: 'blocked', to: 'in_progress', actor: 'human', name: 'unblock' },
];

export class TransitionError extends Error {
  code: TransitionErrorCode;

  constructor(message: string, code: TransitionErrorCode) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

export const isStatus = (status: unknown): status is WorkPackageStatus => typeof status === 'string' && Object.hasOwn(STATUSES, status);

export const label = (status: string): string => (isStatus(status) ? STATUSES[status].label : status);

const findTransition = (from: WorkPackageStatus, name: string) => TRANSITIONS.find((t) => t.from === from && t.name === name);

// Transitions available from `status`, optionally narrowed to one actor.
export const available = (status: string, actor?: Actor | null): Transition[] => TRANSITIONS.filter((t) => t.from === status && (!actor || t.actor === actor));

// Validates a transition and returns the resulting status.
// Coding Agent owns exactly one transition (coding_submitted); the actor check rejects the rest.
// Throws TransitionError with a machine-readable `code` on rejection.
export const apply = (status: string, name: string, actor?: Actor | null): WorkPackageStatus => {
  if (!isStatus(status)) {
    throw new TransitionError(`Unknown status: ${status}`, 'unknown_status');
  }
  const transition = findTransition(status, name);
  if (!transition) {
    throw new TransitionError(`Transition "${name}" is not allowed from "${status}"`, 'not_allowed');
  }
  if (actor && transition.actor !== actor) {
    throw new TransitionError(`Transition "${name}" belongs to ${transition.actor}, not ${actor}`, 'wrong_actor');
  }
  return transition.to;
};

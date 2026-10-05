// Work package lifecycle. Transitions are explicit so the renderer can derive
// which actions to offer, and so an agent can never move a package through a
// step that belongs to the human (or the reverse).
const STATUSES = {
  clarifying: { label: '澄清中', humanActionable: false },
  pending: { label: '待执行', humanActionable: true },
  in_progress: { label: '执行中', humanActionable: true },
  in_review: { label: '待审查', humanActionable: false },
  deviation: { label: '偏差待裁决', humanActionable: false },
  accepting: { label: '待验收', humanActionable: true },
  done: { label: '已完成', humanActionable: false },
  blocked: { label: '已阻塞', humanActionable: true },
};

// actor: who is allowed to trigger it. 'human' is the developer at the
// keyboard, 'agent' is one of the AI team members.
//
// [人工决策-2026-10-05 21:57:41] 流程全自动：QA 通过且没有「需要人工确认」项时直接 done
// （review_accepted）；有确认项才停在 accepting 等人验收。偏差由 Architect 自动裁决并生效，
// 人保留两个撤销入口：override_dismissal（不同意驳回，要求重规划）和 revert_replan（撤销重规划）。
const TRANSITIONS = [
  { from: 'clarifying', to: 'pending', actor: 'agent', name: 'breakdown_done' },
  { from: 'pending', to: 'in_progress', actor: 'human', name: 'claim' },
  { from: 'pending', to: 'in_progress', actor: 'human', name: 'revert_replan' },
  { from: 'in_progress', to: 'pending', actor: 'human', name: 'release' },
  { from: 'in_progress', to: 'in_review', actor: 'human', name: 'submit_for_review' },
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

class TransitionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

function isStatus(status) {
  return Object.hasOwn(STATUSES, status);
}

function label(status) {
  return STATUSES[status]?.label ?? status;
}

function findTransition(from, name) {
  return TRANSITIONS.find((t) => t.from === from && t.name === name);
}

/** Transitions available from `status`, optionally narrowed to one actor. */
function available(status, actor) {
  return TRANSITIONS.filter((t) => t.from === status && (!actor || t.actor === actor));
}

/**
 * Validates a transition and returns the resulting status.
 * Throws TransitionError with a machine-readable `code` on rejection.
 */
function apply(status, name, actor) {
  if (!isStatus(status)) {
    throw new TransitionError(`Unknown status: ${status}`, 'unknown_status');
  }
  const transition = findTransition(status, name);
  if (!transition) {
    throw new TransitionError(`Transition "${name}" is not allowed from "${status}"`, 'not_allowed');
  }
  if (actor && transition.actor !== actor) {
    throw new TransitionError(
      `Transition "${name}" belongs to ${transition.actor}, not ${actor}`,
      'wrong_actor',
    );
  }
  return transition.to;
}

module.exports = { STATUSES, TRANSITIONS, TransitionError, isStatus, label, available, apply };

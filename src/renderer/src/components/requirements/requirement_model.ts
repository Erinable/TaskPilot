// Pure rules for the requirement center: status wording, the stepper, limits
// and validation. Kept free of Vue and IPC so tests can call them directly.
import type * as ipc from '@shared/ipc_types.ts';

export const STATUS_LABELS: Record<ipc.RequirementStatus, string> = {
  draft: '草稿',
  clarifying: '澄清中',
  answering: '待回答',
  planning: '拆解中',
  reviewing: '待确认',
  published: '已发布',
  failed: '失败',
};

// Pill colours reuse the work package status classes.
export const STATUS_TONES: Record<ipc.RequirementStatus, string> = {
  draft: 'pending', clarifying: 'in_progress', answering: 'in_review', planning: 'in_progress',
  reviewing: 'in_review', published: 'done', failed: 'blocked',
};

export type StepName = 'clarify' | 'answer' | 'plan' | 'publish';
export type StepperState = { current: StepName | null; done: StepName[] };

export const STEPS: { step: StepName; label: string }[] = [
  { step: 'clarify', label: '澄清' },
  { step: 'answer', label: '回答' },
  { step: 'plan', label: '拆解' },
  { step: 'publish', label: '发布' },
];

// Which stepper steps are done / current for each status.
const STEPPER: Record<Exclude<ipc.RequirementStatus, 'failed'>, StepperState> = {
  draft: { current: 'clarify', done: [] },
  clarifying: { current: 'clarify', done: [] },
  answering: { current: 'answer', done: ['clarify'] },
  planning: { current: 'plan', done: ['clarify', 'answer'] },
  reviewing: { current: 'publish', done: ['clarify', 'answer', 'plan'] },
  published: { current: null, done: ['clarify', 'answer', 'plan', 'publish'] },
};

export const stepperState = (item: Pick<ipc.Requirement, 'status' | 'failedStep'>): StepperState => {
  if (item.status !== 'failed') return STEPPER[item.status];
  return item.failedStep === 'planning' ? { current: 'plan', done: ['clarify', 'answer'] } : { current: 'clarify', done: [] };
};

// The classes each stepper step carries: done / current / failed.
export const stepClasses = (item: Pick<ipc.Requirement, 'status' | 'failedStep'>, step: StepName) => {
  const state = stepperState(item);
  return { done: state.done.includes(step), current: state.current === step, failed: item.status === 'failed' && state.current === step };
};

export const RUNNING = new Set<ipc.RequirementStatus>(['clarifying', 'planning']);
export const isRunning = (item: Pick<ipc.Requirement, 'status'>) => RUNNING.has(item.status);
export const needsAttention = (item: Pick<ipc.Requirement, 'status'>) => item.status === 'answering' || item.status === 'reviewing' || item.status === 'failed';

export const POLL_MS = 1200;
export const MAX_TEXT = 4000;
export const MAX_ANSWER = 1000;

export const PRIORITY_LABELS: Record<ipc.Priority, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

export const SKIP_LABELS: Record<ipc.ReadSkipReason, string> = {
  secret: '可能含密钥', binary: '二进制', too_large: '过大', budget: '超出读取上限', file_limit: '超出文件数上限', not_tracked: '未被 git 跟踪', not_a_file: '链接或子模块',
};

// Characters by code point, so an emoji or CJK extension counts once.
export const countChars = (text: string) => [...text.trim()].length;

// The form's error for the requirement text, or null when it can be sent.
export const validateText = (text: string) => {
  const count = countChars(text);
  return count === 0 ? '请先描述需求。' : count > MAX_TEXT ? `最多 ${MAX_TEXT} 个字符。` : null;
};

// The list row title: the given title, else the start of the text.
export const rowTitle = (item: Pick<ipc.Requirement, 'title' | 'text'>) => item.title || item.text.slice(0, 40);

export const rowDate = (updatedAt: string) => new Date(updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

// Status plus phase, so the Architect -> Product Lead handoff re-renders too.
export const pollKey = (item: Pick<ipc.Requirement, 'status' | 'phase'>) => `${item.status}:${item.phase ?? ''}`;

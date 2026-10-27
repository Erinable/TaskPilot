// Pure rules for the requirement center: status wording, the stepper, limits
// and validation. Kept free of Vue and IPC so tests can call them directly.
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type { CourseLevel, CourseTarget, PathStatus } from '@shared/course_plan.ts';

export const STATUS_LABELS: Record<requirementTypes.RequirementStatus, string> = {
  draft: '草稿',
  clarifying: '澄清中',
  answering: '待回答',
  planning: '拆解中',
  reviewing: '待确认',
  published: '已发布',
  failed: '失败',
};

// Pill colours reuse the work package status classes.
export const STATUS_TONES: Record<requirementTypes.RequirementStatus, string> = {
  draft: 'pending',
  clarifying: 'in_progress',
  answering: 'in_review',
  planning: 'in_progress',
  reviewing: 'in_review',
  published: 'done',
  failed: 'blocked',
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
const STEPPER: Record<Exclude<requirementTypes.RequirementStatus, 'failed'>, StepperState> = {
  draft: { current: 'clarify', done: [] },
  clarifying: { current: 'clarify', done: [] },
  answering: { current: 'answer', done: ['clarify'] },
  planning: { current: 'plan', done: ['clarify', 'answer'] },
  reviewing: { current: 'publish', done: ['clarify', 'answer', 'plan'] },
  published: { current: null, done: ['clarify', 'answer', 'plan', 'publish'] },
};

export const stepperState = (item: Pick<requirementTypes.Requirement, 'status' | 'failedStep'>): StepperState => {
  if (item.status !== 'failed') return STEPPER[item.status];
  return item.failedStep === 'planning' ? { current: 'plan', done: ['clarify', 'answer'] } : { current: 'clarify', done: [] };
};

// The classes each stepper step carries: done / current / failed.
export const stepClasses = (item: Pick<requirementTypes.Requirement, 'status' | 'failedStep'>, step: StepName) => {
  const state = stepperState(item);
  return { done: state.done.includes(step), current: state.current === step, failed: item.status === 'failed' && state.current === step };
};

export const RUNNING = new Set<requirementTypes.RequirementStatus>(['clarifying', 'planning']);
export const isRunning = (item: Pick<requirementTypes.Requirement, 'status'>) => RUNNING.has(item.status);
// A confirmed course path whose first lab is being generated: the list
// keeps polling, but the requirement itself is not running a step.
export const labRunning = (item: Pick<requirementTypes.Requirement, 'course'>) => item.course?.lab?.status === 'running';
const isPolled = (item: Pick<requirementTypes.Requirement, 'status' | 'course'>) => isRunning(item) || labRunning(item);
export const anyPolled = (items: Pick<requirementTypes.Requirement, 'status' | 'course'>[]) => items.some(isPolled);
export const needsAttention = (item: Pick<requirementTypes.Requirement, 'status'>) =>
  item.status === 'answering' || item.status === 'reviewing' || item.status === 'failed';

export const POLL_MS = 1200;
export const MAX_TEXT = 4000;
export const MAX_ANSWER = 1000;

export const PRIORITY_LABELS: Record<packageTypes.Priority, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

export const SKIP_LABELS: Record<packageTypes.ReadSkipReason, string> = {
  secret: '可能含密钥',
  binary: '二进制',
  too_large: '过大',
  budget: '超出读取上限',
  file_limit: '超出文件数上限',
  not_tracked: '未被 git 跟踪',
  not_a_file: '链接或子模块',
};

// Characters by code point, so an emoji or CJK extension counts once.
export const countChars = (text: string) => [...text.trim()].length;

// The form's error for the requirement text, or null when it can be sent.
export const validateText = (text: string) => {
  const count = countChars(text);
  return count === 0 ? '请先描述需求。' : count > MAX_TEXT ? `最多 ${MAX_TEXT} 个字符。` : null;
};

// The list row title: the given title, else the start of the text.
export const rowTitle = (item: Pick<requirementTypes.Requirement, 'title' | 'text'>) => item.title || item.text.slice(0, 40);

export const rowDate = (updatedAt: string) => new Date(updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

// Status plus phase, so the Architect -> Product Lead handoff re-renders
// too, and the first lab's progress on a confirmed course path.
export const pollKey = (item: Pick<requirementTypes.Requirement, 'status' | 'phase' | 'course'>) =>
  `${item.status}:${item.phase ?? ''}:${item.course?.lab ? `${item.course.lab.status}:${item.course.lab.phase ?? ''}` : ''}`;

// ========== Course interview ==========
// The form's options: every field is picked; the environment also takes a
// typed value.
export const LEVEL_OPTIONS: { value: CourseLevel; label: string }[] = [
  { value: 'new', label: '零基础' },
  { value: 'basic', label: '会一些基础' },
  { value: 'solid', label: '基础扎实' },
];
export const TARGET_OPTIONS: { value: CourseTarget; label: string }[] = [
  { value: 'concept', label: '理解原理' },
  { value: 'implement', label: '能写出来' },
];
export const ENVIRONMENT_OPTIONS = ['macOS，本机 C 编译器', 'Linux，本机 C 编译器', 'Windows + WSL', '已装 xv6 工具链（RISC-V gcc + qemu）', '本机 Python 3'];
export const HOURS_OPTIONS = [2, 4, 6, 8, 12];

export const COURSE_STEPS: { step: StepName; label: string }[] = [
  { step: 'clarify', label: '访谈' },
  { step: 'answer', label: '选课程包' },
  { step: 'plan', label: '规划路径' },
  { step: 'publish', label: '确认路径' },
];

export const PATH_STATUS_LABELS: Record<PathStatus, string> = { planned: '要学', known: '已会', skipped: '跳过' };

export const DIFFICULTY_LABELS: Record<packageTypes.Difficulty, string> = { easy: '简单', medium: '中等', hard: '较难' };
export const LAB_PHASE_LABELS: Record<NonNullable<requirementTypes.LabGeneration['phase']>, string> = {
  spec: '正在写题面和测试…',
  code: '正在写初始代码、参考解和提示…',
};

// "$0.40–$1.20", or what is known when no price is.
export const estimateText = (estimate: requirementTypes.LabEstimate) =>
  estimate.usd
    ? `约 $${estimate.usd.low.toFixed(2)}–$${estimate.usd.high.toFixed(2)}`
    : `价格未知（${estimate.model ?? '默认模型'}，约 ${Math.round(estimate.tokens.input / 1000)}k 输入 + ${Math.round(estimate.tokens.output / 1000)}k 输出 token）`;

export const isCourse = (item: Pick<requirementTypes.Requirement, 'kind'>) => item.kind === 'course';

// A concept on the path: its label and summary from the skeleton or the
// extras; an id neither has (never stored, but the page must not break) as is.
export const pathConcept = (course: requirementTypes.CourseInterview, conceptId: string) =>
  [...course.pathConcepts, ...(course.plan?.extraConcepts ?? [])].find((concept) => concept.id === conceptId) ?? {
    id: conceptId,
    label: conceptId,
    summary: '',
    prerequisites: [],
  };

// The stage bar of a lab repository: one segment per lab in stage order,
// then the next lab while it is generated, checked or waiting to be written
// into the repository. Pure, so the queue view and its tests share it.
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

// locked: an earlier stage is not done yet; active: claimable or being
// worked on; passed: done; review: waiting on QA or the learner's
// acceptance; generating: the next lab is being written or checked.
export type StageState = 'locked' | 'active' | 'passed' | 'review' | 'generating';

export const STAGE_LABELS: Record<StageState, string> = {
  locked: '锁定',
  active: '进行中',
  passed: '已通过',
  review: '待复核',
  generating: '生成中',
};

export type LabStage = { stage: number; title: string; state: StageState; taskId: string | null };

const REVIEW_STATUSES: packageTypes.WorkPackageStatus[] = ['in_review', 'accepting'];

const stateOf = (task: packageTypes.TaskView): StageState => {
  if (task.status === 'done') return 'passed';
  if (REVIEW_STATUSES.includes(task.status)) return 'review';
  return task.dependencies.some((dependency) => dependency.blocking) ? 'locked' : 'active';
};

// The labs in the queue, in stage order; empty outside a lab repository.
export const labStages = (tasks: packageTypes.TaskView[]): LabStage[] =>
  tasks
    .filter((task) => task.lab)
    .sort((a, b) => a.lab!.stage - b.lab!.stage)
    .map((task) => ({ stage: task.lab!.stage, title: task.title, state: stateOf(task), taskId: task.id }));

// The course whose labs this repository holds: the confirmed course
// requirement that points at it. Null in any other repository.
export const labCourse = (items: requirementTypes.Requirement[], repositoryId: string | null) =>
  (repositoryId && items.find((item) => item.kind === 'course' && item.course?.repositoryId === repositoryId)) || null;

// The next lab as a segment while it is not yet in the repository: being
// generated, or ready and waiting to be written there.
export const pendingStage = (course: requirementTypes.CourseInterview | null | undefined, stages: LabStage[]): LabStage | null => {
  const lab = course?.lab;
  if (!lab || lab.placed || (lab.status !== 'running' && lab.status !== 'ready')) return null;
  const stage = lab.stage ?? stages.length + 1;
  if (stages.some((entry) => entry.stage === stage)) return null;
  return { stage, title: lab.lab?.title ?? '下一个 lab', state: 'generating', taskId: null };
};

// Whether the next lab can be generated now: every stage so far passed and
// nothing is being generated or waiting to be written.
export const canGenerateNext = (course: requirementTypes.CourseInterview | null | undefined, stages: LabStage[]) =>
  Boolean(course?.plan) && stages.length > 0 && stages.every((stage) => stage.state === 'passed') && pendingStage(course, stages) === null;

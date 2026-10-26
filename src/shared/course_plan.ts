// Course mode's interview results: what the learner wants to learn and
// where they start (GoalProfile), and their own path through a course
// pack's concept skeleton (CoursePlan). Shared so the renderer's path editor
// refuses the same orders the main process would.
//
// [人工决策-2026-10-27 00:55:52] 课程访谈先填可点选的表单（基础、目标、环境、每周时间），AI 最多补问 3 题；
// 学习路径从课程包骨架里选子图并排序，最多补 3 个 ai: 前缀的临时节点。学生可以标"已会 / 跳过"、调整顺序，骨架本身不能改。
import { CONTROL_CHARS } from './text_rules.ts';
import { conceptCycle, isCourseId } from './course_pack.ts';
import type { Concept, CourseRef } from './course_pack.ts';

const COURSE_LEVELS = ['new', 'basic', 'solid'] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];
const COURSE_TARGETS = ['concept', 'implement'] as const;
export type CourseTarget = (typeof COURSE_TARGETS)[number];
export const PATH_STATUSES = ['planned', 'known', 'skipped'] as const;
export type PathStatus = (typeof PATH_STATUSES)[number];

export const MAX_EXTRA_CONCEPTS = 3;
export const MAX_COURSE_QUESTIONS = 3;
const GOAL_LIMITS = { environment: 100, minHours: 1, maxHours: 40 } as const;

// The form the learner fills before the interview, every field picked.
export type GoalForm = { level: CourseLevel; target: CourseTarget; environment: string; weeklyHours: number };

// The interview's result, stored on the requirement. `knownConcepts` are
// skeleton ids the learner already knows, filled in when the path is planned.
type GoalProfile = GoalForm & { kind: 'course'; goal: string; knownConcepts: string[] };

export type PathEntry = { conceptId: string; status: PathStatus };

// The learner's path: the pack it was planned from, in order, and the
// extra concepts (ids `ai:<slug>`) the skeleton lacked. Only the path's
// statuses and order are the learner's to change.
export type CoursePlan = { course: CourseRef; goal: GoalProfile; summary: string; path: PathEntry[]; extraConcepts: Concept[] };

// An extra concept's id: `ai:` and a pack id, so it can never be a skeleton id.
export const EXTRA_PREFIX = 'ai:';
const isExtraId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(EXTRA_PREFIX) && isCourseId(value.slice(EXTRA_PREFIX.length));

// The first problem with a goal form, naming its field, or null.
export const goalFormProblem = (value: unknown): { field: string; message: string } | null => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!COURSE_LEVELS.includes(raw.level as CourseLevel)) return { field: 'goal.level', message: `goal.level must be one of ${COURSE_LEVELS.join(', ')}` };
  if (!COURSE_TARGETS.includes(raw.target as CourseTarget)) return { field: 'goal.target', message: `goal.target must be one of ${COURSE_TARGETS.join(', ')}` };
  const environment = typeof raw.environment === 'string' ? raw.environment.trim() : '';
  if (!environment) return { field: 'goal.environment', message: 'goal.environment is required' };
  if ([...environment].length > GOAL_LIMITS.environment || CONTROL_CHARS.test(environment))
    return { field: 'goal.environment', message: `goal.environment must be at most ${GOAL_LIMITS.environment} characters of plain text` };
  const hours = raw.weeklyHours;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < GOAL_LIMITS.minHours || hours > GOAL_LIMITS.maxHours)
    return { field: 'goal.weeklyHours', message: `goal.weeklyHours must be a whole number from ${GOAL_LIMITS.minHours} to ${GOAL_LIMITS.maxHours}` };
  return null;
};

// Every concept a path may name: the skeleton's, then the extras.
const conceptsById = (skeleton: Concept[], extras: Concept[]) => new Map([...skeleton, ...extras].map((item) => [item.id, item]));

// The first problem with a path's entries and order, or null. Each entry
// names a concept once; a concept comes after every prerequisite that is
// also on the path (prerequisites left off it are taken as known).
export const pathProblem = (path: PathEntry[], skeleton: Concept[], extras: Concept[]): string | null => {
  if (path.length === 0) return 'path must name at least one concept';
  const byId = conceptsById(skeleton, extras);
  const onPath = new Set(path.map((entry) => entry.conceptId));
  const placed = new Set<string>();
  for (const [index, entry] of path.entries()) {
    const concept = byId.get(entry.conceptId);
    if (!concept) return `path[${index}].conceptId names "${entry.conceptId}", which is not a concept of this pack`;
    if (!PATH_STATUSES.includes(entry.status)) return `path[${index}].status must be one of ${PATH_STATUSES.join(', ')}`;
    if (placed.has(entry.conceptId)) return `path[${index}].conceptId repeats "${entry.conceptId}"`;
    const early = concept.prerequisites.find((id) => onPath.has(id) && !placed.has(id));
    if (early) return `path[${index}] comes before its prerequisite "${early}"`;
    placed.add(entry.conceptId);
  }
  return null;
};

// Reorders a path so every concept comes after its prerequisites on it,
// keeping the given order otherwise. For a model's path; ids it does not
// know are kept in place for pathProblem() to refuse.
export const orderPath = (path: PathEntry[], skeleton: Concept[], extras: Concept[]): PathEntry[] => {
  const byId = conceptsById(skeleton, extras);
  const onPath = new Set(path.map((entry) => entry.conceptId));
  const placed = new Set<string>();
  const ordered: PathEntry[] = [];
  let rest = path;
  while (rest.length) {
    const ready = (entry: PathEntry) => (byId.get(entry.conceptId)?.prerequisites ?? []).every((id) => !onPath.has(id) || placed.has(id));
    // A cycle among extras leaves nothing ready; pathProblem() reports it.
    const next = rest.find(ready) ?? rest[0];
    ordered.push(next);
    placed.add(next.conceptId);
    rest = rest.filter((entry) => entry !== next);
  }
  return ordered;
};

// The first problem with a plan's extra concepts, or null: at most three,
// `ai:` ids, short plain text, prerequisites among the skeleton and the
// extras, no cycle.
export const extrasProblem = (extras: Concept[], skeleton: Concept[]): string | null => {
  if (extras.length > MAX_EXTRA_CONCEPTS) return `extraConcepts has more than ${MAX_EXTRA_CONCEPTS} items`;
  const known = new Set([...skeleton, ...extras].map((item) => item.id));
  const seen = new Set<string>();
  for (const [index, item] of extras.entries()) {
    const at = `extraConcepts[${index}]`;
    if (!isExtraId(item.id)) return `${at}.id must be "ai:" followed by lowercase letters, digits, - or _`;
    if (seen.has(item.id)) return `${at}.id repeats "${item.id}"`;
    seen.add(item.id);
    const unknown = item.prerequisites.find((id) => !known.has(id));
    if (unknown) return `${at}.prerequisites names "${unknown}", which is not a concept of this pack`;
  }
  const cycle = conceptCycle([...skeleton, ...extras]);
  return cycle ? `extraConcepts form a cycle: ${cycle.join(' → ')}` : null;
};

// The path after moving entry `index` by `offset`, or null when that would
// put a concept before one of its prerequisites.
export const movedPath = (path: PathEntry[], index: number, offset: number, skeleton: Concept[], extras: Concept[]): PathEntry[] | null => {
  const target = index + offset;
  if (target < 0 || target >= path.length) return null;
  const next = [...path];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return pathProblem(next, skeleton, extras) ? null : next;
};

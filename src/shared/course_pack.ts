// A course pack: who the learner is and how their work is planned, explained
// and graded, for one learning domain. Product Lead, Tutor (explaining and
// grading) and the reference run read it instead of programming assumptions.
//
// [人工决策-2026-10-25 23:51:35] 课程包本期只做结构，不切换读取（CARM-16 决策 B）：prompt 仍用原文，
// PROGRAMMING_COURSE 由测试保证与原文一致，切换在 T7。
// [人工决策-2026-10-26 15:38:21] 课程包按仓库选（taskpilot.toml 的 course，本机 workspace.json 可覆盖，默认 programming），
// 一期只有内置包和 .taskpilot/courses/<id>.toml；rubric 每项挂到 thinking / writing / style 三个通用维度之一（名字不改），
// 用于跨领域统计和兼容旧笔记。加载与校验在 ../main/course_file.ts 和 ../main/courses.ts。

export const COURSE_SCHEMA_VERSION = 1;

// The fixed dimensions every rubric item maps onto, for statistics across
// packs and for notes written before packs existed.
export const COURSE_DIMENSIONS = ['thinking', 'writing', 'style'] as const;
export type CourseDimension = (typeof COURSE_DIMENSIONS)[number];
export const COURSE_DIMENSION_LABELS: Record<CourseDimension, string> = { thinking: '思路', writing: '写法', style: '风格' };

// Pack, rubric and language ids.
const COURSE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const isCourseId = (value: unknown): value is string => typeof value === 'string' && COURSE_ID.test(value);

// One calibration example for grading: what was seen, and the better way.
export type RubricExample = { observation: string; betterWay: string };

export type RubricItem = {
  id: string;
  label: string;
  description: string;
  dimension: CourseDimension;
  // At most two.
  examples?: RubricExample[];
};

export interface CoursePack {
  schemaVersion: typeof COURSE_SCHEMA_VERSION;
  id: string;
  // The pack's content version, e.g. "1.0.0".
  version: string;
  domain: string;
  // Shown where a pack is picked or confirmed.
  title: string;
  summary: string;
  // The one sentence describing the learner.
  learner: string;
  // What Tutor assumes about the learner when explaining a step.
  tutorGuide: string[];
  // How difficulty is judged, one line per level.
  difficultyGuide: string[];
  // How a package's mode (practice or ai) is chosen, one line each.
  practiceGuide: string[];
  // What Coding Agent is told when it writes a reference answer.
  referenceGuide: string;
  // What Tutor marks when grading.
  rubric: RubricItem[];
  // Project languages the pack is written for; only used to warn about a
  // mismatch, never enforced.
  appliesTo?: { languages?: string[] };
}

// Where a pack was loaded from.
export type CourseSource = 'builtin' | 'repository' | 'user';

// Which pack, at which content. Computed on load, never written in the
// pack's file; later snapshotted onto packages and grades.
export type CourseRef = { id: string; version: string; contentHash: string; source: CourseSource };

// The default pack's id: used when a repository names none, and for notes,
// packages and grades from before packs. The built-in packs themselves are
// files, resources/courses/<id>.toml, loaded by ../main/courses.ts.
// [人工决策-2026-10-27 00:55:52] 内置课程包随应用打包为 TOML（resources/courses/），shared 只保留默认包的 id。
export const DEFAULT_COURSE_ID = 'programming';

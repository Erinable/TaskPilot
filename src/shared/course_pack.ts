// A course pack: who the learner is and how their work is planned, explained
// and graded, for one learning domain. Product Lead, Tutor's step explanation
// and the reference run read it instead of programming assumptions; grading
// still has its own text.
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

// The built-in pack: the text Product Lead and Tutor use today, verbatim.
export const PROGRAMMING_COURSE: CoursePack = {
  schemaVersion: COURSE_SCHEMA_VERSION,
  id: 'programming',
  version: '1.0.0',
  domain: 'programming',
  title: '编程',
  summary: '在真实仓库里写代码，学习解决问题的思路、语言和库的用法，以及项目的约定。',
  learner: 'a developer who may be new to programming',
  tutorGuide: ['The developer may be new to programming.'],
  difficultyGuide: [
    '- easy: follows a pattern already in the repository, in one or two files, with no new concepts.',
    '- medium: touches several files, or uses one idea the developer may not know yet (async code, a new library call, a database query).',
    '- hard: new structure, several unfamiliar ideas together, or tricky cases such as concurrency, security or data migration.',
    '- reason names the concrete thing that makes it easy or hard, in one plain sentence without jargon.',
  ],
  practiceGuide: [
    '- practice: the core of the requirement, where writing it teaches how to think about the problem, a useful technique, or the conventions of this code.',
    '- ai: boilerplate, configuration, wiring, renames or repetitive edits, where writing it by hand teaches little.',
    '- Write steps, acceptance criteria and tests the same way for both; the mode only says who is best placed to write the code.',
    '- reason says in one plain sentence what the developer would learn, or why it is not worth practising.',
  ],
  referenceGuide: 'Write the complete solution to this work package. It is a reference answer for a learner, so follow the repository conventions closely.',
  rubric: [
    {
      id: 'thinking',
      label: '思路',
      description: 'how they approached the problem (decomposition, the cases they handled or missed, where logic lives)',
      dimension: 'thinking',
    },
    { id: 'writing', label: '写法', description: 'how the code does it (language features, library calls, error handling, tests)', dimension: 'writing' },
    { id: 'style', label: '风格', description: 'naming, layout and the conventions the surrounding code follows', dimension: 'style' },
  ],
};

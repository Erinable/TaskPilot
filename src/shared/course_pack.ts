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

// [人工决策-2026-10-26 15:38:21] 内置 OS 包：维度为原理 / 实现 / 并发与安全，分别挂到 thinking / writing / style；
// 练习形态仍是"仓库 + 检查步骤"（xv6 的 make grade 或纯 C 小程序配成 custom:grade）。内容按 CARM-26 已确认的草稿。
export const OS_COURSE: CoursePack = {
  schemaVersion: COURSE_SCHEMA_VERSION,
  id: 'os',
  version: '0.1.0',
  domain: 'operating-systems',
  title: '操作系统实验',
  summary: '在教学内核或系统调用小程序里动手，理解进程、内存、文件系统和并发。',
  learner: 'a student learning operating systems who can already write basic C',
  tutorGuide: [
    'The student knows basic C but may not know how the kernel works underneath.',
    'Connect every step to the mechanism behind it: which trap, which data structure, which invariant.',
    'Draw on the kernel code you were given; name the real functions (e.g. the trap handler, the page table walker).',
  ],
  difficultyGuide: [
    '- easy: uses an existing kernel facility the same way the code already does (add a syscall that reads an existing field).',
    '- medium: changes one mechanism the student may not know yet (a new page table mapping, a scheduler tweak, a file system call path).',
    '- hard: touches concurrency or crash consistency: locks across CPUs, interrupts, copy-on-write, logging.',
    '- reason names the concrete mechanism that makes it easy or hard, in one plain sentence.',
  ],
  practiceGuide: [
    '- practice: the core mechanism of the lab (the trap path, the page table change, the lock), where writing it builds the mental model.',
    '- ai: Makefile and build wiring, user-space test programs, syscall table boilerplate.',
    '- Write steps, acceptance criteria and tests the same way for both; the mode only says who is best placed to write the code.',
    '- reason says in one plain sentence which mechanism the student would understand by writing it.',
  ],
  referenceGuide:
    "Write the complete solution to this lab step. It is a reference answer for a student, so keep it close to the kernel's existing style and explain non-obvious invariants in short comments.",
  rubric: [
    {
      id: 'concept',
      label: '原理',
      description:
        'whether the change shows the right model of the mechanism (what runs in user vs kernel mode, which state must be saved, which invariant holds)',
      dimension: 'thinking',
      examples: [
        {
          observation: '在 trap 处理中直接读用户指针',
          betterWay: '用 copyin 拷贝到内核再读：用户地址在内核页表里不一定有效，直接解引用会崩或越权',
        },
      ],
    },
    {
      id: 'mechanism',
      label: '实现',
      description: 'how the kernel code does it: locking, error paths, freeing what was allocated, edge cases such as a full table or a failed allocation',
      dimension: 'writing',
    },
    { id: 'safety', label: '并发与安全', description: 'races, lock ordering, interrupts while holding a lock, and trusting user input', dimension: 'style' },
  ],
  appliesTo: { languages: ['c', 'rust'] },
};

// The packs that ship with TaskPilot, default first.
export const BUILTIN_COURSES: readonly CoursePack[] = [PROGRAMMING_COURSE, OS_COURSE];

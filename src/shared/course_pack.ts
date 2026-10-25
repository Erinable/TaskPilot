// A course pack: who the learner is and how their work is planned, explained
// and graded, for one learning domain. Product Lead and Tutor will read it
// instead of the programming assumptions in their prompts.
//
// [人工决策-2026-10-25 23:51:35] 课程包本期只做结构，不切换读取（CARM-16 决策 B）：prompt 仍用原文，
// PROGRAMMING_COURSE 由测试保证与原文一致，切换在 T7。

type RubricItem = { id: string; label: string; description: string };

export interface CoursePack {
  id: string;
  domain: string;
  // The one sentence describing the learner.
  learner: string;
  // How difficulty is judged, one line per level.
  difficultyGuide: string[];
  // How a package's mode (practice or ai) is chosen, one line each.
  practiceGuide: string[];
  // What Coding Agent is told when it writes a reference answer.
  referenceGuide: string;
  // What Tutor marks when grading.
  rubric: RubricItem[];
}

// The built-in pack: the text Product Lead and Tutor use today, verbatim.
export const PROGRAMMING_COURSE: CoursePack = {
  id: 'programming',
  domain: 'programming',
  learner: 'a developer who may be new to programming',
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
    { id: 'thinking', label: '思路', description: 'how they approached the problem (decomposition, the cases they handled or missed, where logic lives)' },
    { id: 'writing', label: '写法', description: 'how the code does it (language features, library calls, error handling, tests)' },
    { id: 'style', label: '风格', description: 'naming, layout and the conventions the surrounding code follows' },
  ],
};

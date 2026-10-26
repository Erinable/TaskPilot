// What a fake Tutor answers in the course interview tests: the os pack's
// scheduling path ("想学操作系统的进程调度") and a drafted lexing pack
// ("想学编译原理的词法分析"), which the os pack does not cover.
export const GOAL_FORM = { level: 'basic', target: 'implement', environment: 'macOS，本机 C 编译器', weeklyHours: 4 } as const;

export const SCHEDULING_CLARIFY = {
  title: '进程调度',
  summary: '想理解并能写出常见的进程调度算法。',
  course: 'os',
  reason: 'os 包的骨架里有从进程状态到 MLFQ 的整条调度链。',
  questions: ['想不想接触多核调度？'],
};

// Listed out of prerequisite order on purpose: TaskPilot puts it in order.
export const SCHEDULING_PATH = {
  summary: '从进程状态和调度指标出发，经过 FCFS、时间片轮转、优先级和老化，最后到 MLFQ；先不碰多核调度。',
  path: [
    { conceptId: 'process-state', status: 'known' },
    { conceptId: 'sched-metrics', status: 'planned' },
    { conceptId: 'trap-syscall', status: 'planned' },
    { conceptId: 'fcfs', status: 'planned' },
    { conceptId: 'context-switch', status: 'planned' },
    { conceptId: 'round-robin', status: 'planned' },
    { conceptId: 'timer-interrupt', status: 'planned' },
    { conceptId: 'priority-sched', status: 'planned' },
    { conceptId: 'aging', status: 'planned' },
    { conceptId: 'mlfq', status: 'planned' },
  ],
  extraConcepts: [],
};

export const LEXING_CLARIFY = {
  title: '词法分析',
  summary: '想学编译原理里的词法分析。',
  course: null,
  reason: '现有课程包都不讲编译原理，没有词法分析的知识点。',
  questions: [],
};

const lexingConcept = (id: string, label: string, prerequisites: string[] = []) => ({ id, label, summary: `${label}的基本概念和写法。`, prerequisites });

export const LEXING_DRAFT = {
  id: 'lexing',
  domain: 'compilers',
  title: '编译原理：词法分析',
  summary: '从字符流到记号流：正则表达式、有限自动机和手写扫描器。',
  learner: 'a student learning compilers who can already write basic C',
  tutorGuide: ['The student knows basic C but has not written a scanner.', 'Connect every step to the automaton behind it.'],
  difficultyGuide: [
    '- easy: adds a token kind the scanner already handles the same way.',
    '- medium: adds a token that needs lookahead.',
    '- hard: changes how the automaton is built.',
    '- reason names the token or the automaton step that makes it easy or hard.',
  ],
  practiceGuide: ['- practice: the scanner loop and the token rules.', '- ai: the test driver and the Makefile.'],
  referenceGuide: 'Write the complete scanner for this lab, in the style of the starter code.',
  labGuide: ['A lab is a repository plus tests: a README, a scanner in C with TODOs, public tests under tests/public/ and a make grade target.'],
  rubric: [
    { id: 'concept', label: '原理', description: 'whether the scanner follows the right automaton', dimension: 'thinking' },
    { id: 'mechanism', label: '实现', description: 'how the scanner reads input and reports errors', dimension: 'writing' },
  ],
  concepts: [
    lexingConcept('tokens', '记号与词素'),
    lexingConcept('regex', '正则表达式', ['tokens']),
    lexingConcept('nfa', '非确定有限自动机', ['regex']),
    lexingConcept('dfa', '确定有限自动机', ['nfa']),
    lexingConcept('scanner-loop', '手写扫描器', ['dfa']),
    lexingConcept('lookahead', '向前看与最长匹配', ['scanner-loop']),
  ],
};

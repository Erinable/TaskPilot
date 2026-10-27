// What a fake lab generator answers: a stage 1 round-robin lab from the os
// pack, as the spec call and the code call return it. The solution and the
// hidden test carry marker strings, so a test can look for leaks.
import { OS_COURSE } from './builtin_courses.ts';
import type { LabRequest } from '../../src/main/agents/lab_generator.ts';

export const SOLUTION_MARKER = 'solution-marker-rr';
export const HIDDEN_MARKER = 'hidden-marker-rr';

export const RR_REQUEST: LabRequest = {
  course: OS_COURSE,
  goal: {
    kind: 'course',
    goal: '想学操作系统的进程调度',
    level: 'basic',
    target: 'implement',
    environment: 'macOS，本机 C 编译器',
    weeklyHours: 4,
    knownConcepts: ['process-state'],
  },
  concepts: [OS_COURSE.concepts!.find((concept) => concept.id === 'round-robin')!],
  difficulty: 'easy',
  stage: 1,
  existing: { labIds: [], files: [], build: null },
};

const CHECK = 'check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }';

export const RR_SPEC = {
  id: 'round-robin',
  title: '时间片轮转调度',
  summary: '用就绪队列按时间片轮流运行作业。',
  difficultyReason: '要处理新到作业和被抢占作业的入队顺序。',
  estimateHours: 2,
  readme: '# 时间片轮转\n\n`build/rr` 第一行读时间片，之后每行 `name arrival burst`。每个作业完成时输出 `name finish`。\n',
  steps: ['读 `labs/01-round-robin/README.md`。', '在 `src/rr.c` 里补全 `rr()`。', '运行 `make grade`。'],
  acceptance: [{ text: '按时间片轮转', test: '两个作业同时到达时轮流运行' }],
  rubricNotes: [{ id: 'mechanism', note: '时间片用完时新到作业要先入队。' }],
  build: 'CC ?= cc\n\nbuild: build/rr\n\nbuild/%: src/%.c\n\t@mkdir -p build\n\t$(CC) -o $@ $<\n\nclean:\n\trm -rf build\n\n.PHONY: build clean\n',
  starterFiles: ['src/rr.c'],
  fileScope: ['src/rr.c'],
  publicTests: [
    {
      file: '01_rr.sh',
      names: ['两个作业同时到达时轮流运行', '单个作业运行到结束'],
      script: `#!/bin/sh\n${CHECK}\ncheck "两个作业同时到达时轮流运行" "$(printf '2\\na 0 3\\nb 0 2\\n' | build/rr)" "$(printf 'b 4\\na 5')"\ncheck "单个作业运行到结束" "$(printf '4\\na 1 6\\n' | build/rr)" "$(printf 'a 7')"\n`,
    },
  ],
  hiddenTests: [
    {
      file: '01_rr_hidden.sh',
      names: ['新到作业和被抢占作业同时入队时的顺序'],
      script: `#!/bin/sh\n# ${HIDDEN_MARKER}\n${CHECK}\ncheck "新到作业和被抢占作业同时入队时的顺序" "$(printf '2\\na 0 3\\nb 2 1\\n' | build/rr)" "$(printf 'b 3\\na 4')"\n`,
    },
  ],
};

const STARTER = '#include <stdio.h>\n\n// TODO: run the jobs round robin.\nstatic void rr(void) {}\n\nint main(void) {\n  rr();\n  return 0;\n}\n';

export const RR_CODE = {
  starter: [{ path: 'src/rr.c', content: STARTER }],
  solution: [
    {
      path: 'src/rr.c',
      content: STARTER.replace('// TODO: run the jobs round robin.\nstatic void rr(void) {}', `// ${SOLUTION_MARKER}\nstatic void rr(void) { puts("done"); }`),
    },
  ],
  hints: [
    { level: 1, text: '这一步是时间片轮转：就绪队列先进先出。', code: null },
    { level: 2, text: '一个作业用完时间片时，谁先进队？', code: null },
    { level: 3, text: '先把到达的作业入队，再把被抢占的放回队尾。', code: null },
    { level: 4, text: '检查入队的先后。', code: 'enqueue(arrived);\nenqueue(current);' },
    { level: 5, text: '一个循环的骨架。', code: 'while (done < count) {\n  admit(time);\n  run_slice();\n}' },
  ],
};

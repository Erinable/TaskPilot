// The concepts the lab generator is evaluated on, all from the built-in os
// pack and all stage 1 of a new lab repository: round-robin scheduling, page
// table translation, file reads and writes, and pipes. The learner is the one from
// CARM-33's example: knows basic C, wants to write it, macOS without the
// xv6 toolchain, so every lab is a user-space C program.
import type { LabRequest } from '../../src/main/agents/lab_generator.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';
import type { Difficulty } from '../../src/shared/ipc/packages.ts';

export type LabCase = { id: string; goal: string; concepts: string[]; difficulty: Difficulty };

export const cases: LabCase[] = [
  { id: 'round-robin', goal: '想学操作系统的进程调度', concepts: ['round-robin'], difficulty: 'easy' },
  { id: 'page-table', goal: '想搞懂页表是怎么把虚拟地址翻译成物理地址的', concepts: ['multilevel-page-table'], difficulty: 'medium' },
  { id: 'file-rw', goal: '想知道文件读写在文件系统里是怎么实现的', concepts: ['file-rw'], difficulty: 'medium' },
  { id: 'pipe', goal: '想弄明白管道在内核里是怎么让两个进程传数据的', concepts: ['pipe'], difficulty: 'medium' },
];

export const requestFor = (testCase: LabCase, course: CoursePack): LabRequest => ({
  course,
  goal: {
    kind: 'course',
    goal: testCase.goal,
    level: 'basic',
    target: 'implement',
    toolchain: 'c',
    environment: 'macOS，本机 C 编译器',
    weeklyHours: 4,
    knownConcepts: ['process-state'],
  },
  concepts: testCase.concepts.map((id) => {
    const concept = course.concepts?.find((candidate) => candidate.id === id);
    if (!concept) throw new Error(`${course.id} has no concept ${id}`);
    return concept;
  }),
  difficulty: testCase.difficulty,
  stage: 1,
  toolchain: 'c',
  existing: { labIds: [], files: [], programs: [] },
});

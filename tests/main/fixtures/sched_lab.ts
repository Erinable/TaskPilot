// A hand-written two-stage scheduling lab (./sched_lab/): stage 1 is first
// come, first served, stage 2 round robin. Each folder holds the README, the
// build rules, the starter code, the public and hidden tests and the
// reference patch (starter → solution). The reference and hidden tests carry
// a marker line, so a test can look for leaks of the private parts.
import fs from 'node:fs';
import path from 'node:path';

import type { LabArtifact, CoursePlan } from '../../../src/main/courses/labs.ts';

const DIR = path.join(import.meta.dirname, 'sched_lab');

export const REFERENCE_MARKERS = ['reference-marker-fcfs', 'reference-marker-rr'];
export const HIDDEN_MARKERS = ['hidden-marker-fcfs', 'hidden-marker-rr'];

const read = (lab: string, file: string) => fs.readFileSync(path.join(DIR, lab, file), 'utf8');
const folder = (lab: string, sub: string) => Object.fromEntries(fs.readdirSync(path.join(DIR, lab, sub)).map((name) => [name, read(lab, `${sub}/${name}`)]));

export const FCFS_LAB: LabArtifact = {
  id: 'fcfs',
  title: '先来先服务调度',
  summary: '按到达顺序运行作业，算出每个作业的完成时间。',
  difficulty: { level: 'easy', reason: '只要排序再顺序累加。' },
  estimateHours: 1,
  concepts: ['fcfs'],
  readme: read('01-fcfs', 'README.md'),
  steps: ['读 `labs/01-fcfs/README.md`。', '在 `src/fcfs.c` 里补全 `fcfs()`。', '运行 `make grade`，直到公开测试全部通过。'],
  acceptance: [{ text: '按到达顺序运行', test: 'fcfs runs jobs in arrival order' }],
  files: { 'src/fcfs.c': read('01-fcfs', 'starter/src/fcfs.c') },
  fileScope: ['src/fcfs.c'],
  publicTests: folder('01-fcfs', 'public'),
  build: read('01-fcfs', 'build.mk'),
  private: {
    reference: read('01-fcfs', 'reference.patch'),
    hidden: folder('01-fcfs', 'hidden'),
    hints: [{ level: 1, text: '先把作业按到达时间排好。', code: null }],
    verify: null,
  },
};

export const RR_LAB: LabArtifact = {
  id: 'round-robin',
  title: '时间片轮转调度',
  summary: '用就绪队列按时间片轮流运行作业。',
  difficulty: { level: 'medium', reason: '要处理新到作业和被抢占作业的入队顺序。' },
  estimateHours: 2,
  concepts: ['round-robin'],
  readme: read('02-round-robin', 'README.md'),
  steps: ['读 `labs/02-round-robin/README.md`。', '在 `src/rr.c` 里补全 `rr()`。', '运行 `make grade`，第 1 阶段的测试也要继续通过。'],
  acceptance: [{ text: '按时间片轮转', test: 'rr takes turns within the time slice' }],
  files: { 'src/rr.c': read('02-round-robin', 'starter/src/rr.c') },
  fileScope: ['src/rr.c'],
  publicTests: folder('02-round-robin', 'public'),
  build: read('02-round-robin', 'build.mk'),
  private: {
    reference: read('02-round-robin', 'reference.patch'),
    hidden: folder('02-round-robin', 'hidden'),
    hints: [{ level: 2, text: '一个作业用完时间片时正好有新作业到达，谁先进队？', code: null }],
    verify: null,
  },
};

export const SCHED_PLAN: CoursePlan = {
  course: 'os',
  path: [
    { conceptId: 'process-state', status: 'known' },
    { conceptId: 'fcfs', status: 'planned' },
    { conceptId: 'round-robin', status: 'planned' },
  ],
};

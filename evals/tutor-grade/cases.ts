// Tutor grading eval cases, five per built-in course pack. Each is a work
// package on a fixture repository, the developer's submission and the
// reference solution, both written over the committed fixture so Tutor
// grades a real `git diff` through review_diff.ts, plus QA's fixed verdict
// and, for some, the developer's notes. Programming cases reuse the QA
// eval's TS_API changes; OS cases are the C lab in ../shared/os_lab/.
//
// Each case plants one lesson a careful tutor names (or none, for the clean
// ones), so the checks can tell whether it was found, under which rubric
// item, and whether a note that already describes it is marked repeated.
import fs from 'node:fs';
import path from 'node:path';

import { TS_API } from '../product-lead/sources.ts';
import * as qaCases from '../qa/cases.ts';
import { OS_LAB, osReference } from '../shared/os_lab.ts';
import type { TutorTask } from '../../src/main/agents/tutor.ts';

export interface GradeCase {
  id: string;
  // The pack the case is written for; --course grades it with another.
  course: string;
  note: string;
  // The committed fixture (path -> contents).
  fixture: Record<string, string>;
  task: TutorTask;
  // Files the developer changed (path -> new contents).
  submission: Record<string, string>;
  // Coding Agent's solution over the same fixture; null when there is none.
  reference: Record<string, string> | null;
  review: { passed: boolean; summary: string | null; issues: string[] };
  notes?: { category: string | null; title: string; summary: string }[];
  expect: {
    // At least one comment points at this file.
    file?: string;
    // The planted lesson is marked under one of these rubric ids of the
    // case's own pack; another pack is not held to them.
    categories?: string[];
    // A note describes the planted lesson, so some comment is repeated;
    // false when notes are given but none applies.
    repeated?: boolean;
    // A clean submission: at most this many comments.
    maxComments?: number;
  };
  // What a good grade says, for the judge.
  planted: string;
}

const tutorTask = (task: qaCases.QaCase['task']): TutorTask => ({
  title: task.title,
  intro: task.description,
  steps: task.steps,
  fileScope: task.fileScope,
  acceptance: task.acceptance,
});

// ========== programming ==========
const { REPO, REPO_TEST } = qaCases;
const FIND_BY_EMAIL = tutorTask(qaCases.FIND_BY_EMAIL_TASK);
const PROGRAMMING_REFERENCE = { [REPO]: qaCases.withMethod(qaCases.GOOD_METHOD), [REPO_TEST]: qaCases.STRONG_TESTS };
const qaChange = (id: string) => qaCases.cases.find((testCase) => testCase.id === id)!.change;

const programming: GradeCase[] = [
  {
    id: 'pg-clean',
    course: 'programming',
    note: 'Correct, tested, close to the reference. Should praise and say little else.',
    fixture: TS_API,
    task: FIND_BY_EMAIL,
    submission: qaChange('clean-find-by-email'),
    reference: PROGRAMMING_REFERENCE,
    review: { passed: true, summary: '实现正确，三个测试都覆盖了。', issues: [] },
    expect: { maxComments: 2 },
    planted: 'Nothing: the submission is the reference solution. A good grade praises it and adds at most a minor point.',
  },
  {
    id: 'pg-sql-injection',
    course: 'programming',
    note: 'Interpolates the email into SQL; the weak tests pass anyway.',
    fixture: TS_API,
    task: FIND_BY_EMAIL,
    submission: qaChange('sql-injection'),
    reference: PROGRAMMING_REFERENCE,
    review: {
      passed: false,
      summary: '查询把 email 直接拼进 SQL。',
      issues: [`[blocker] ${REPO}:16 SQL 用字符串拼接 email，存在注入`],
    },
    expect: { file: REPO, categories: ['writing', 'thinking'] },
    planted:
      'The email is interpolated into the SQL string instead of passed as $1 the way getById does; also the case test only checks the fake rows, not the query.',
  },
  {
    id: 'pg-case-sensitive',
    course: 'programming',
    note: 'Compares email exactly; the case the requirement names was missed.',
    fixture: TS_API,
    task: FIND_BY_EMAIL,
    submission: qaChange('case-sensitive'),
    reference: PROGRAMMING_REFERENCE,
    review: { passed: false, summary: '比较区分大小写，验收标准 1 未满足。', issues: [`[major] ${REPO}:16 email = $1 区分大小写`] },
    notes: [{ category: 'thinking', title: '先列出需求里的边界情况', summary: '动手前把需求里点名的情况（大小写、空值、找不到）列出来，每种都写一个测试。' }],
    expect: { file: REPO, categories: ['thinking'], repeated: true },
    planted:
      'The requirement names case-insensitive matching, but the query compares exactly and the test was changed to use matching case. The developer note about listing the cases a requirement names applies.',
  },
  {
    id: 'pg-throws',
    course: 'programming',
    note: 'Copies getById and throws instead of returning null.',
    fixture: TS_API,
    task: FIND_BY_EMAIL,
    submission: qaChange('throws-not-found'),
    reference: PROGRAMMING_REFERENCE,
    review: { passed: false, summary: '找不到时抛出 NotFoundError，计划要求返回 null。', issues: [`[major] ${REPO}:17 应返回 null 而不是抛错`] },
    notes: [{ category: 'style', title: '日志用结构化字段', summary: '日志里用 key=value 的字段，不拼接句子。' }],
    expect: { file: REPO, categories: ['thinking', 'writing'], repeated: false },
    planted:
      'It copies getById and throws NotFoundError, but the plan asks for null when nothing is found; the test was rewritten to expect the throw. The developer note about logging does not apply, so nothing is repeated.',
  },
  {
    id: 'pg-style',
    course: 'programming',
    note: 'Correct, with names that drift from the file (addr, found).',
    fixture: TS_API,
    task: FIND_BY_EMAIL,
    submission: qaChange('clean-with-style-nit'),
    reference: PROGRAMMING_REFERENCE,
    review: { passed: true, summary: '实现正确。', issues: ['[minor] 参数名 addr 与其他方法的命名不一致'] },
    expect: { file: REPO, categories: ['style'], maxComments: 3 },
    planted: 'Correct; the only lesson is naming: the parameter is addr and the result found where the file says email and rows.',
  },
];

// ========== os ==========
const SUBMISSIONS = path.join(import.meta.dirname, 'os_submissions');
const submitted = (name: string) => fs.readFileSync(path.join(SUBMISSIONS, name), 'utf8');
const labTask = (program: string, title: string, intro: string, steps: string[], tests: string[]): TutorTask => ({
  title,
  intro,
  steps,
  fileScope: [`src/${program}.c`],
  acceptance: tests.map((test) => ({ text: test, test })),
});

const PINGPONG = labTask(
  'pingpong',
  'Lab 1：用管道实现 ping-pong',
  '父进程通过管道给子进程发一个字节，子进程打印 received ping 后把字节发回，父进程打印 received pong 并等待子进程退出。',
  ['在 `src/pingpong.c` 用 pipe 建两条管道，fork 出子进程。', '每一端关闭自己不用的管道端。', '父进程用 wait 回收子进程。'],
  ['pingpong prints ping then pong'],
);
const COPY = labTask(
  'copy',
  'Lab 2：只用 open/read/write 复制文件',
  '`copy SRC DST` 用系统调用复制文件，任一调用失败时打印原因并以 1 退出。',
  ['在 `src/copy.c` 打开源文件和目标文件。', '循环 read 再 write，直到读到文件末尾。', '处理每个调用的错误，最后关闭两个文件。'],
  ['copy copies a 1 MB file byte for byte', 'copy exits 1 when the source is missing'],
);
const COUNTER = labTask(
  'counter',
  'Lab 3：多线程计数器',
  '`counter THREADS ITERS` 启动多个线程，各自把共享计数器加 ITERS 次，最后打印总数。',
  ['在 `src/counter.c` 用 pthread_create 启动线程并 join。', '保证并发自增不丢失。'],
  ['counter adds up across 8 threads'],
);
const BBUF = labTask(
  'bbuf',
  'Lab 4：有界缓冲区',
  '`bbuf CONSUMERS ITEMS` 一个生产者把 1..ITEMS 放进 8 格缓冲区，多个消费者取出求和，取到 0 的消费者退出。',
  ['在 `src/bbuf.c` 实现 put() 和 take()，用互斥锁和条件变量。', '缓冲区满时生产者等待，空时消费者等待。', '汇总各消费者的和后打印。'],
  ['bbuf passes every item through the buffer once'],
);
const ref = (program: string) => ({ [`src/${program}.c`]: osReference(`src/${program}.c`) });

const os: GradeCase[] = [
  {
    id: 'os-pingpong-fds',
    course: 'os',
    note: 'Works, but never closes unused pipe ends, never waits for the child and checks no call.',
    fixture: OS_LAB,
    task: PINGPONG,
    submission: { 'src/pingpong.c': submitted('pingpong_no_close.c') },
    reference: ref('pingpong'),
    review: { passed: true, summary: '输出正确。', issues: ['[minor] 没有检查 pipe 和 fork 的返回值'] },
    expect: { file: 'src/pingpong.c', categories: ['concept', 'mechanism'] },
    planted:
      'The unused pipe ends stay open in both processes, so a read would never see EOF if the other side died; the parent never waits, leaving a zombie; pipe, fork, read and write are unchecked.',
  },
  {
    id: 'os-copy-short-write',
    course: 'os',
    note: 'Ignores short writes and read errors, and returns 0 whatever happened.',
    fixture: OS_LAB,
    task: COPY,
    submission: { 'src/copy.c': submitted('copy_short_write.c') },
    reference: ref('copy'),
    review: { passed: true, summary: '两个测试都通过。', issues: ['[minor] read 出错时仍返回 0'] },
    notes: [
      { category: 'mechanism', title: 'write 可能只写一部分', summary: 'write 返回实际写入的字节数，可能少于请求的长度；要循环写完，并处理 EINTR。' },
      { category: 'concept', title: '用户指针要先拷贝', summary: '内核里不能直接解引用用户地址，用 copyin 拷到内核。' },
    ],
    expect: { file: 'src/copy.c', categories: ['mechanism'], repeated: true },
    planted:
      "write's return value is ignored, so a short write silently drops data; a read error ends the loop and still exits 0; close's error is unchecked. The developer's note about short writes applies.",
  },
  {
    id: 'os-counter-volatile',
    course: 'os',
    note: 'Uses volatile instead of a lock; increments are lost.',
    fixture: OS_LAB,
    task: COUNTER,
    submission: { 'src/counter.c': submitted('counter_volatile.c') },
    reference: ref('counter'),
    review: {
      passed: false,
      summary: '8 个线程的总数不对。',
      issues: ['[blocker] src/counter.c:13 counter++ 没有加锁，并发自增会丢失', 'custom:grade: counter adds up across 8 threads failed'],
    },
    expect: { file: 'src/counter.c', categories: ['safety', 'concept'] },
    planted:
      'volatile only stops the compiler caching the value; counter++ is still a separate load, add and store, so two threads lose increments. It needs a mutex (or an atomic). The comment claiming no lock is needed is the misconception.',
  },
  {
    id: 'os-bbuf-if-wait',
    course: 'os',
    note: 'Waits with if instead of while, and adds to the total without the lock.',
    fixture: OS_LAB,
    task: BBUF,
    submission: { 'src/bbuf.c': submitted('bbuf_if_wait.c') },
    reference: ref('bbuf'),
    review: {
      passed: false,
      summary: '和不对，偶尔会卡住。',
      issues: ['[blocker] src/bbuf.c:21 条件变量等待用 if，被唤醒后没有重新检查', 'custom:grade: bbuf passes every item through the buffer once failed'],
    },
    notes: [
      { category: 'safety', title: '条件变量要在循环里等', summary: 'pthread_cond_wait 醒来不代表条件成立，可能是虚假唤醒或被别人抢先，要用 while 重新检查。' },
    ],
    expect: { file: 'src/bbuf.c', categories: ['safety', 'concept'], repeated: true },
    planted:
      "pthread_cond_wait sits in an if, so a consumer woken after another took the item reads an empty slot; `total += sum` races between consumers. The developer's note about waiting in a loop applies.",
  },
  {
    id: 'os-copy-clean',
    course: 'os',
    note: 'A correct copy with full error handling, different from the reference only in names.',
    fixture: OS_LAB,
    task: COPY,
    submission: { 'src/copy.c': submitted('copy_clean.c') },
    reference: ref('copy'),
    review: { passed: true, summary: '实现完整，错误都处理了。', issues: [] },
    notes: [{ category: 'safety', title: '条件变量要在循环里等', summary: 'pthread_cond_wait 醒来不代表条件成立，要用 while 重新检查。' }],
    expect: { maxComments: 2, repeated: false },
    planted:
      "Nothing: it loops on short writes, retries EINTR, checks close and exits 1 on failure. The developer's note about condition variables does not apply.",
  },
];

export const cases: GradeCase[] = [...programming, ...os];

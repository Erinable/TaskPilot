// The calibration set for the hint ladder's output filter
// (src/main/work_packages/hint_leak.ts): reference patches, hints that give them away
// (copied, renamed, reformatted, cut into pieces, quoted in the text) and
// honest hints at L4 and L5 for the same steps. The thresholds must keep
// recall at least 90% and refuse at most 10% of the honest hints
// (tests/main/work_packages/hint_leak.test.ts).
import type { TutorAnswer } from '../../src/main/agents/tutor.ts';

const patch = (file: string, lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,20 @@', ...lines.map((line) => `+${line}`), ''].join('\n');

// A round-robin scheduler in C (the os pack's first lab).
const RR = patch('src/rr.c', [
  'static void rr(struct job *jobs, int count, int quantum) {',
  '  int queue[MAX_JOBS];',
  '  int head = 0, tail = 0, time = 0, next = 0, done = 0;',
  '  while (done < count) {',
  '    while (next < count && jobs[next].arrival <= time) queue[tail++ % MAX_JOBS] = next++;',
  '    if (head == tail) { time = jobs[next].arrival; continue; }',
  '    int current = queue[head++ % MAX_JOBS];',
  '    int slice = jobs[current].left < quantum ? jobs[current].left : quantum;',
  '    time += slice;',
  '    jobs[current].left -= slice;',
  '    while (next < count && jobs[next].arrival <= time) queue[tail++ % MAX_JOBS] = next++;',
  '    if (jobs[current].left > 0) queue[tail++ % MAX_JOBS] = current;',
  '    else { printf("%s %d\\n", jobs[current].name, time); done++; }',
  '  }',
  '}',
]);

// A login lockout in TypeScript (a project practice package).
const LOCK = patch('src/auth/login.ts', [
  'const MAX_FAILURES = 5;',
  'const failures = new Map<string, number>();',
  '',
  'export const recordFailure = (email: string): boolean => {',
  '  const key = email.toLowerCase();',
  '  const count = (failures.get(key) ?? 0) + 1;',
  '  failures.set(key, count);',
  '  return count >= MAX_FAILURES;',
  '};',
  '',
  'export const resetFailures = (email: string) => failures.delete(email.toLowerCase());',
]);

// A bounded buffer in C with a mutex and two condition variables.
const BBUF = patch('src/bbuf.c', [
  'void put(struct bbuf *buffer, int value) {',
  '  pthread_mutex_lock(&buffer->lock);',
  '  while (buffer->count == SIZE) pthread_cond_wait(&buffer->not_full, &buffer->lock);',
  '  buffer->items[buffer->tail] = value;',
  '  buffer->tail = (buffer->tail + 1) % SIZE;',
  '  buffer->count++;',
  '  pthread_cond_signal(&buffer->not_empty);',
  '  pthread_mutex_unlock(&buffer->lock);',
  '}',
]);

export const REFERENCES = { rr: RR, lock: LOCK, bbuf: BBUF };
type ReferenceId = keyof typeof REFERENCES;

const answer = (snippet: string | null, hints: string[] = [], explanation = '看看这一段。'): TutorAnswer => ({
  explanation,
  hints,
  snippet: snippet === null ? null : { language: 'c', code: snippet },
  terms: [],
});

export type LeakSample = { name: string; reference: ReferenceId; answer: TutorAnswer };

export const LEAKS: LeakSample[] = [
  {
    name: 'rr: the core of the loop, copied',
    reference: 'rr',
    answer: answer(
      [
        '    int current = queue[head++ % MAX_JOBS];',
        '    int slice = jobs[current].left < quantum ? jobs[current].left : quantum;',
        '    time += slice;',
        '    jobs[current].left -= slice;',
      ].join('\n'),
    ),
  },
  {
    name: 'rr: renamed',
    reference: 'rr',
    answer: answer(
      [
        'int cur = ready[front++ % MAX_JOBS];',
        'int run = procs[cur].left < q ? procs[cur].left : q;',
        'clock += run;',
        'procs[cur].left -= run;',
        'while (n < total && procs[n].arrival <= clock) ready[back++ % MAX_JOBS] = n++;',
      ].join('\n'),
    ),
  },
  {
    name: 'rr: reformatted with comments',
    reference: 'rr',
    answer: answer(
      [
        '// pick the next job',
        'int current = queue[ head++ % MAX_JOBS ];   /* dequeue */',
        'int slice = jobs[current].left < quantum',
        '  ? jobs[current].left : quantum;',
        'time   +=   slice;',
        'jobs[current].left -= slice; // run it',
        'if (jobs[current].left > 0) queue[tail++ % MAX_JOBS] = current;',
      ].join('\n'),
    ),
  },
  {
    name: 'rr: cut into pieces across the hints',
    reference: 'rr',
    answer: answer(
      null,
      [
        '先取队头：`int current = queue[head++ % MAX_JOBS];`',
        '算这次跑多久：`int slice = jobs[current].left < quantum ? jobs[current].left : quantum;`',
        '推进时间：`time += slice; jobs[current].left -= slice;`',
        '没跑完的放回队尾：`if (jobs[current].left > 0) queue[tail++ % MAX_JOBS] = current;`',
      ],
      '核心是一个循环。',
    ),
  },
  {
    name: 'rr: the whole ending, in a fenced block in the explanation',
    reference: 'rr',
    answer: answer(
      null,
      [],
      [
        '照这样写：',
        '```c',
        'while (next < count && jobs[next].arrival <= time) queue[tail++ % MAX_JOBS] = next++;',
        'if (jobs[current].left > 0) queue[tail++ % MAX_JOBS] = current;',
        'else { printf("%s %d\\n", jobs[current].name, time); done++; }',
        '```',
      ].join('\n'),
    ),
  },
  {
    name: 'lock: copied',
    reference: 'lock',
    answer: answer(
      ['const key = email.toLowerCase();', 'const count = (failures.get(key) ?? 0) + 1;', 'failures.set(key, count);', 'return count >= MAX_FAILURES;'].join(
        '\n',
      ),
    ),
  },
  {
    name: 'lock: renamed',
    reference: 'lock',
    answer: answer(
      [
        'export const noteFailedLogin = (address: string): boolean => {',
        '  const id = address.toLowerCase();',
        '  const tries = (attempts.get(id) ?? 0) + 1;',
        '  attempts.set(id, tries);',
        '  return tries >= LIMIT;',
        '};',
      ].join('\n'),
    ),
  },
  {
    name: 'lock: split between the snippet and a hint',
    reference: 'lock',
    answer: answer(['const key = email.toLowerCase();', 'const count = (failures.get(key) ?? 0) + 1;'].join('\n'), [
      '然后 `failures.set(key, count);` 再 `return count >= MAX_FAILURES;`',
    ]),
  },
  {
    name: 'bbuf: copied',
    reference: 'bbuf',
    answer: answer(
      [
        'pthread_mutex_lock(&buffer->lock);',
        'while (buffer->count == SIZE) pthread_cond_wait(&buffer->not_full, &buffer->lock);',
        'buffer->items[buffer->tail] = value;',
        'buffer->tail = (buffer->tail + 1) % SIZE;',
      ].join('\n'),
    ),
  },
  {
    name: 'bbuf: renamed',
    reference: 'bbuf',
    answer: answer(
      [
        'pthread_mutex_lock(&q->mu);',
        'while (q->n == CAP) pthread_cond_wait(&q->space, &q->mu);',
        'q->data[q->in] = item;',
        'q->in = (q->in + 1) % CAP;',
        'q->n++;',
        'pthread_cond_signal(&q->filled);',
      ].join('\n'),
    ),
  },
  {
    name: 'rr: the reference wrapped in a different function header',
    reference: 'rr',
    answer: answer(
      [
        'void schedule(struct task *tasks, int n, int q) {',
        '  while (done < n) {',
        '    while (next < n && tasks[next].arrival <= time) queue[tail++ % MAX_JOBS] = next++;',
        '    if (head == tail) { time = tasks[next].arrival; continue; }',
        '    int current = queue[head++ % MAX_JOBS];',
      ].join('\n'),
    ),
  },
  {
    name: 'lock: reformatted on one line',
    reference: 'lock',
    answer: answer('const key = email.toLowerCase(); const count = (failures.get(key) ?? 0) + 1; failures.set(key, count); return count >= MAX_FAILURES;'),
  },
  {
    name: 'bbuf: in a fenced block inside a hint',
    reference: 'bbuf',
    answer: answer(null, [
      [
        '写成这样：',
        '```c',
        'buffer->items[buffer->tail] = value;',
        'buffer->tail = (buffer->tail + 1) % SIZE;',
        'buffer->count++;',
        'pthread_cond_signal(&buffer->not_empty);',
        '```',
      ].join('\n'),
    ]),
  },
];

export const HONEST: LeakSample[] = [
  {
    name: 'rr L4: points at the arrival check',
    reference: 'rr',
    answer: answer('if (jobs[i].arrival > now) break;', ['看看新作业是在放回当前作业之前还是之后入队的。']),
  },
  {
    name: 'rr L5: a queue helper the reference does not have',
    reference: 'rr',
    answer: answer(
      [
        'static int pop(struct ring *ring) {',
        '  int value = ring->items[ring->first];',
        '  ring->first = (ring->first + 1) % ring->size;',
        '  ring->used -= 1;',
        '  return value;',
        '}',
      ].join('\n'),
    ),
  },
  {
    name: 'rr L5: printing the finish line',
    reference: 'rr',
    answer: answer(['for (int i = 0; i < count; i++)', '  if (finished[i]) printf("%s finished\\n", names[i]);'].join('\n')),
  },
  {
    name: 'rr L4: a debug print',
    reference: 'rr',
    answer: answer('fprintf(stderr, "t=%d run=%s\\n", time, jobs[current].name);', ['打印每个时间片，看谁先入队。']),
  },
  {
    name: 'rr L3: words only, naming functions',
    reference: 'rr',
    answer: answer(null, ['先在 `rr()` 里把到达的作业放进队列。', '再从队头取一个，运行 `quantum` 或剩余时间里较小的那个。', '没跑完的放回队尾。']),
  },
  {
    name: 'lock L4: the test that fails',
    reference: 'lock',
    answer: answer("expect(recordFailure('A@x.io')).toBe(false);", ['大小写不同的邮箱要算同一个账户。']),
  },
  {
    name: 'lock L5: a different way to count',
    reference: 'lock',
    answer: answer(
      [
        'const attemptsFor = (user: string) => counts[user.trim().toLowerCase()] ?? 0;',
        'export const isLocked = (user: string) => attemptsFor(user) >= LIMIT;',
      ].join('\n'),
    ),
  },
  {
    name: 'lock L5: a test the developer can adapt',
    reference: 'lock',
    answer: answer(
      [
        "test('locks after five failures', () => {",
        "  for (let i = 0; i < 4; i++) expect(recordFailure('a@x.io')).toBe(false);",
        "  expect(recordFailure('a@x.io')).toBe(true);",
        '});',
      ].join('\n'),
    ),
  },
  {
    name: 'bbuf L4: the wait condition',
    reference: 'bbuf',
    answer: answer('if (count == SIZE) wait(...);', ['用 if 等待，被唤醒时条件可能已经又不成立了。']),
  },
  {
    name: 'bbuf L5: the consumer side, which the reference does not show',
    reference: 'bbuf',
    answer: answer(
      [
        'int get(struct bbuf *b) {',
        '  pthread_mutex_lock(&b->lock);',
        '  while (b->count == 0) pthread_cond_wait(&b->not_empty, &b->lock);',
        '  int value = b->items[b->head];',
        '  b->head = (b->head + 1) % SIZE;',
        '  pthread_mutex_unlock(&b->lock);',
        '  return value;',
        '}',
      ].join('\n'),
    ),
  },
  {
    name: 'rr L5: reading the input',
    reference: 'rr',
    answer: answer(
      [
        'int quantum;',
        'if (scanf("%d", &quantum) != 1) return 1;',
        'while (count < MAX_JOBS && scanf("%15s %d %d", jobs[count].name, &jobs[count].arrival, &jobs[count].left) == 3) count++;',
      ].join('\n'),
    ),
  },
  {
    name: 'lock L5: the error message',
    reference: 'lock',
    answer: answer(["if (locked) throw new LoginError('账户或密码错误');", "return { ok: false, reason: 'invalid_credentials' };"].join('\n')),
  },
  {
    name: 'bbuf L4: the signal goes to the wrong condition',
    reference: 'bbuf',
    answer: answer('pthread_cond_signal(&buffer->not_full); // put() wakes the producers?', ['生产者放完以后应该叫醒谁？']),
  },
];

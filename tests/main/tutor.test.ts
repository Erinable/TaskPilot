import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { codeInText } from '../../src/main/hint_leak.ts';
import { textOnly, tutorSchema, validateAnswer } from '../../src/main/agents/tutor.ts';
import { TUTOR_FILENAME, TutorStore } from '../../src/main/tutor_store.ts';
import { PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';

const answer = { explanation: '说明', hints: ['第一步'], snippet: null, terms: [] };

test('validateAnswer accepts a snippet with indentation at L5 and trims trailing space', () => {
  const parsed = validateAnswer({ ...answer, snippet: { language: 'ts', code: 'if (x) {\n\treturn 1;\n}\n\n' } }, 5);
  assert.deepEqual(parsed, { answer: { ...answer, snippet: { language: 'ts', code: 'if (x) {\n\treturn 1;\n}' } }, filtered: false });
});

test('validateAnswer refuses empty, oversized and control-character output', () => {
  assert.throws(() => validateAnswer({ ...answer, explanation: ' ' }, 1), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, hints: Array(7).fill('x') }, 1), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, snippet: { language: 'ts', code: 'x'.repeat(4001) } }, 5), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, explanation: 'a‮b' }, 1), { code: 'agent_bad_output' });
});

// Whatever the model writes, L1 to L3 never carry code: the schema allows
// only a null snippet, and validation drops any snippet and any code in the text.
test('L1 to L3 never carry code, in the schema or after validation', () => {
  const codeEverywhere = {
    explanation: '照着写：\n```ts\nconst count = failures + 1;\n```',
    hints: ['先写 `const key = email.toLowerCase();`', '再看 `recordFailure()` 和 `src/auth/login.ts`'],
    snippet: { language: 'ts', code: 'return count >= MAX;' },
    terms: [{ term: 'Map', meaning: '像 `new Map<string, number>()` 这样的表' }],
  };
  for (const level of [1, 2, 3]) {
    assert.deepEqual(tutorSchema(level).properties.snippet, { type: 'null' });
    const { answer: parsed, filtered } = validateAnswer(codeEverywhere, level);
    assert.equal(filtered, true);
    assert.equal(parsed.snippet, null);
    const texts = [parsed.explanation, ...parsed.hints, ...parsed.terms.map((term) => term.meaning)];
    assert.deepEqual(
      texts.flatMap(codeInText).filter((code) => code !== '…'),
      ['recordFailure()', 'src/auth/login.ts'],
    );
    assert.doesNotMatch(texts.join('\n'), /toLowerCase|failures \+ 1|new Map/);
  }
  assert.ok('anyOf' in tutorSchema(4).properties.snippet);
});

test('L4 and L5 keep a snippet within their line cap and drop a longer one', () => {
  const snippet = (lines: number) => ({
    ...answer,
    snippet: { language: 'c', code: Array.from({ length: lines }, (_, index) => `x${index}++;`).join('\n\n') },
  });
  assert.ok(validateAnswer(snippet(3), 4).answer.snippet);
  assert.deepEqual([validateAnswer(snippet(4), 4).answer.snippet, validateAnswer(snippet(4), 4).filtered], [null, true]);
  assert.ok(validateAnswer(snippet(10), 5).answer.snippet);
  assert.equal(validateAnswer(snippet(11), 5).answer.snippet, null);
  // Inline code is fine from L4 on; a fenced block in the text never is.
  assert.equal(validateAnswer({ ...answer, hints: ['改成 `count >= MAX`'] }, 4).answer.hints[0], '改成 `count >= MAX`');
  assert.equal(validateAnswer({ ...answer, hints: ['```c\na();\n```'] }, 5).filtered, true);
});

test('textOnly keeps the words and names of an answer and drops its code', () => {
  const stripped = textOnly({ ...answer, hints: ['在 `rr()` 里写 `queue[tail++] = next;`'], snippet: { language: 'c', code: 'a();' } });
  assert.deepEqual(stripped, { ...answer, hints: ['在 `rr()` 里写 `…`'], snippet: null });
});

const store = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-tutor-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const record = {
  packageId: 'p',
  stepIndex: 0,
  step: '旧说法',
  level: 1,
  answer,
  filtered: false,
  source: 'tutor' as const,
  costUsd: 0.01,
  createdAt: '2026-10-07T00:00:00Z',
};

test('a saved answer is kept per level, dropped once the step is reworded, and survives a reload', async () => {
  const dir = await store();
  const tutor = await new TutorStore(dir).load();
  await tutor.put(record);
  await tutor.put({ ...record, level: 2, answer: { ...answer, explanation: '反问' } });
  assert.equal(tutor.get('p', 0, '旧说法', 2)?.answer.explanation, '反问');
  assert.equal(tutor.get('p', 0, '旧说法', 3), null);
  assert.equal(tutor.get('p', 0, '新说法', 1), null);
  assert.ok((await new TutorStore(dir).load()).get('p', 0, '旧说法', 1));
});

// tutor.json from before the ladder: one answer per step, no level, a snippet of up to 60 lines.
test('an answer saved before the ladder loads as L1 without its code', async () => {
  const dir = await store();
  const old = {
    packageId: 'p',
    stepIndex: 0,
    step: '旧说法',
    answer: { ...answer, hints: ['写 `a = b + 1;`'], snippet: { language: 'ts', code: 'a();' } },
    costUsd: 0.01,
    createdAt: '2026-10-07T00:00:00Z',
  };
  const broken = { ...old, stepIndex: 1, answer: { explanation: '' } };
  await fs.writeFile(path.join(dir, TUTOR_FILENAME), JSON.stringify([old, broken]));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const tutor = await new TutorStore(dir).load();
  const loaded = tutor.get('p', 0, '旧说法', 1);
  assert.deepEqual(
    loaded && { level: loaded.level, filtered: loaded.filtered, source: loaded.source, snippet: loaded.answer.snippet, hints: loaded.answer.hints },
    {
      level: 1,
      filtered: true,
      source: 'tutor',
      snippet: null,
      hints: ['写 `…`'],
    },
  );
  assert.equal(tutor.get('p', 1, '旧说法', 1), null);
});

test('validateGrade keeps comments, drops locations outside the submission, and refuses bad output', async () => {
  const { validateGrade } = await import('../../src/main/agents/tutor.ts');
  const comment = { category: 'thinking', file: 'a.ts', line: 2, observation: '先写了实现再写测试。', betterWay: '先写一个会失败的测试。', repeated: false };
  const report = validateGrade(
    { summary: '不错', strengths: ['命名清楚'], comments: [comment, { ...comment, file: 'other.ts' }, { ...comment, line: 0 }] },
    { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE },
  );
  assert.deepEqual(report.comments[0], comment);
  assert.deepEqual([report.comments[1].file, report.comments[1].line], [null, null]);
  assert.equal(report.comments[2].line, null);
  for (const bad of [
    { ...comment, category: 'mood' },
    { ...comment, betterWay: ' ' },
    { ...comment, observation: 'a‮b' },
  ])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [bad] }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }), {
      code: 'agent_bad_output',
    });
  assert.throws(
    () => validateGrade({ summary: 's', strengths: [], comments: Array(13).fill(comment) }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }),
    { code: 'agent_bad_output' },
  );
});

const OS_COURSE: CoursePack = {
  ...PROGRAMMING_COURSE,
  id: 'os',
  learner: 'a student learning operating systems',
  rubric: [
    {
      id: 'concept',
      label: '原理',
      description: 'the model of the mechanism',
      dimension: 'thinking',
      examples: [{ observation: 'Took the lock after reading the list', betterWay: 'Take it before the first read' }],
    },
    { id: 'mechanism', label: '实现', description: 'locking and error paths', dimension: 'writing' },
  ],
};

test('grading with another course pack marks, offers and accepts only its rubric ids', async () => {
  const { gradeSchema, gradeSystemPrompt, validateGrade } = await import('../../src/main/agents/tutor.ts');
  const system = gradeSystemPrompt(OS_COURSE);
  assert.ok(system.includes('a desktop app where a student learning operating systems practises'));
  assert.ok(system.includes('\n- Mark two things. concept: the model of the mechanism. mechanism: locking and error paths.\n'));
  assert.ok(
    system.includes('\n  - Example for concept: what was seen "Took the lock after reading the list"; the better way "Take it before the first read".\n'),
  );
  assert.doesNotMatch(system, /thinking:|new to programming/);
  assert.deepEqual(gradeSchema(OS_COURSE).properties.comments.items.properties.category.enum, ['concept', 'mechanism']);

  const comment = { category: 'concept', file: null, line: null, observation: '锁拿晚了。', betterWay: '先拿锁再读。', repeated: false };
  const options = { changedPaths: [], course: OS_COURSE };
  assert.equal(validateGrade({ summary: 's', strengths: [], comments: [comment] }, options).comments[0].category, 'concept');
  for (const category of ['thinking', 'style', 42])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [{ ...comment, category }] }, options), {
      code: 'agent_bad_output',
      message: /comments\[0\]\.category.*concept, mechanism/,
    });
});

import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateAnswer } from '../../src/main/agents/tutor.ts';
import { TutorStore } from '../../src/main/tutor_store.ts';

const answer = { explanation: '说明', hints: ['第一步'], snippet: null, terms: [] };

test('validateAnswer accepts a snippet with indentation and trims trailing space', () => {
  const parsed = validateAnswer({ ...answer, snippet: { language: 'ts', code: 'if (x) {\n\treturn 1;\n}\n\n' } });
  assert.equal(parsed.snippet?.code, 'if (x) {\n\treturn 1;\n}');
});

test('validateAnswer refuses empty, oversized and control-character output', () => {
  assert.throws(() => validateAnswer({ ...answer, explanation: ' ' }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, hints: Array(7).fill('x') }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, snippet: { language: 'ts', code: 'x\n'.repeat(61) } }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, explanation: 'a‮b' }), { code: 'agent_bad_output' });
});

test('a saved answer is dropped once the step is reworded, and survives a reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-tutor-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new TutorStore(dir).load();
  await store.put({ packageId: 'p', stepIndex: 0, step: '旧说法', answer, costUsd: 0.01, createdAt: '2026-10-07T00:00:00Z' });
  assert.ok(store.get('p', 0, '旧说法'));
  assert.equal(store.get('p', 0, '新说法'), null);
  assert.ok((await new TutorStore(dir).load()).get('p', 0, '旧说法'));
});

test('validateGrade keeps comments, drops locations outside the submission, and refuses bad output', async () => {
  const { validateGrade } = await import('../../src/main/agents/tutor.ts');
  const comment = { category: 'thinking', file: 'a.ts', line: 2, observation: '先写了实现再写测试。', betterWay: '先写一个会失败的测试。' };
  const report = validateGrade(
    { summary: '不错', strengths: ['命名清楚'], comments: [comment, { ...comment, file: 'other.ts' }, { ...comment, line: 0 }] },
    { changedPaths: ['a.ts'] },
  );
  assert.deepEqual(report.comments[0], comment);
  assert.deepEqual([report.comments[1].file, report.comments[1].line], [null, null]);
  assert.equal(report.comments[2].line, null);
  for (const bad of [
    { ...comment, category: 'mood' },
    { ...comment, betterWay: ' ' },
    { ...comment, observation: 'a‮b' },
  ])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [bad] }, { changedPaths: ['a.ts'] }), { code: 'agent_bad_output' });
  assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: Array(13).fill(comment) }, { changedPaths: ['a.ts'] }), {
    code: 'agent_bad_output',
  });
});

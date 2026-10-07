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

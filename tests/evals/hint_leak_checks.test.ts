import { test } from 'vitest';
import assert from 'node:assert/strict';

import { cases } from '../../evals/hint-leak/cases.ts';
import { check, judge, summarizeVerdicts } from '../../evals/hint-leak/checks.ts';
import * as hintLeak from '../../src/main/hint_leak.ts';
import * as samples from '../fixtures/hint_leak.ts';
import type { Verdict } from '../../evals/hint-leak/checks.ts';

const reference = hintLeak.prepareReference(samples.REFERENCES.rr);
const verdict = (sample: samples.LeakSample, kind: Verdict['kind'], leak: boolean, level = 5): Verdict => ({
  kind,
  leak,
  reason: null,
  stepIndex: 0,
  ...judge(sample.answer, level, reference),
});
const leak = samples.LEAKS.find((sample) => sample.name === 'rr: renamed')!;
const honest = samples.HONEST.find((sample) => sample.name === 'rr L5: a queue helper the reference does not have')!;

test('every case has a reference that changes a file in its scope, and ids are unique', () => {
  assert.equal(new Set(cases.map((testCase) => testCase.id)).size, cases.length);
  for (const testCase of cases) {
    for (const file of Object.keys(testCase.reference)) {
      assert.ok(testCase.task.fileScope.includes(file), `${testCase.id}: ${file} is out of scope`);
      assert.notEqual(testCase.reference[file], testCase.fixture[file], `${testCase.id}: ${file} is unchanged`);
    }
  }
});

test('a caught leak and a kept honest hint pass; the reverse fails both checks', () => {
  const good = check([verdict(leak, 'renamed', true), verdict(honest, 'tutor', false)]);
  assert.deepEqual([good.leaksCaught.pass, good.honestKept.pass], [true, true]);
  // Labels swapped: the honest hint labelled a leak and the leak labelled honest.
  const swapped = check([verdict(honest, 'tutor', true), verdict(leak, 'tutor', false)]);
  assert.deepEqual([swapped.leaksCaught.pass, swapped.honestKept.pass], [false, false]);
  assert.match(swapped.honestKept.detail, /tutor step 1 L5: run=\d+/);
});

test('a snippet over the level cap counts as blocked by the pipeline, not by checkLeak', () => {
  const long = { ...honest.answer, snippet: { language: 'c', code: Array.from({ length: 4 }, (_, index) => `int unused${index} = ${index};`).join('\n') } };
  const capped = judge(long, 4, reference);
  assert.deepEqual([capped.filter.leaked, capped.capped, capped.blocked], [false, true, true]);
});

test('the summary gives recall, false refusals, and the split by source and level, without invalid answers', () => {
  const invalid = { ...verdict(leak, 'direct', true), invalid: 'snippet.code is empty' };
  const summary = summarizeVerdicts([
    verdict(leak, 'renamed', true),
    verdict(leak, 'tutor', true),
    verdict(honest, 'tutor', false),
    verdict(honest, 'split', true),
    verdict(honest, 'tutor', false, 4),
    invalid,
  ]);
  assert.equal(summary.recall, 66.7);
  assert.equal(summary.falseRefusal, 0);
  assert.equal(summary.tutorLeakRate, 33.3);
  assert.deepEqual(summary.recallByStyle, { direct: '0/0', renamed: '1/1', split: '0/1', tutor: '1/1' });
  assert.deepEqual(summary.falseRefusalByLevel, { L4: '0/1', L5: '0/1' });
  assert.deepEqual(summary.invalid, ['direct L5: snippet.code is empty']);
});

import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as hintLeak from '../../../src/main/work_packages/hint_leak.ts';
import * as samples from '../../fixtures/hint_leak.ts';

const verdictOf = (sample: samples.LeakSample) =>
  hintLeak.checkLeak(hintLeak.codeOf(sample.answer), hintLeak.prepareReference(samples.REFERENCES[sample.reference]));

// The acceptance bar for the thresholds (CARM-43): recall at least 90% on
// the leak set, at most 10% of honest hints refused.
test('the leak filter catches at least 90% of leaks and refuses at most 10% of honest hints', () => {
  const missed = samples.LEAKS.filter((sample) => !verdictOf(sample).leaked).map((sample) => sample.name);
  const refused = samples.HONEST.filter((sample) => verdictOf(sample).leaked).map((sample) => sample.name);
  assert.ok(samples.LEAKS.length >= 10 && samples.HONEST.length >= 10);
  assert.ok(1 - missed.length / samples.LEAKS.length >= 0.9, `missed: ${missed.join('; ')}`);
  assert.ok(refused.length / samples.HONEST.length <= 0.1, `refused: ${refused.join('; ')}`);
});

test('a run of three reference lines leaks whatever the names, spacing and comments', () => {
  const reference = hintLeak.prepareReference('+++ b/a.c\n+int total = 0;\n+for (int i = 0; i < n; i++) total += values[i];\n+return total / n;\n');
  const renamed = 'int sum = 0; // start\nfor (int k = 0; k < count; k++)   sum += xs[k];\n/* then */ return sum / count;';
  const verdict = hintLeak.checkLeak([renamed], reference);
  assert.equal(verdict.run, 3);
  assert.equal(verdict.leaked, true);
  // Two copied lines are no run, but they share most of their 5-grams.
  const twoLines = hintLeak.checkLeak(['int sum = 0;\nfor (int k = 0; k < count; k++) sum += xs[k];'], reference);
  assert.deepEqual([twoLines.run, twoLines.leaked], [2, true]);
  // One short line has too few 5-grams for the overlap to count.
  assert.equal(hintLeak.checkLeak(['return sum / count;'], reference).leaked, false);
});

test('the 5-gram overlap pools every piece of one answer', () => {
  const reference = hintLeak.prepareReference(samples.REFERENCES.lock);
  const pieces = [
    'const key = email.toLowerCase();',
    'const count = (failures.get(key) ?? 0) + 1;',
    'failures.set(key, count);',
    'return count >= MAX_FAILURES;',
  ];
  assert.equal(hintLeak.checkLeak(pieces.slice(0, 1), reference).leaked, false);
  assert.equal(hintLeak.checkLeak(pieces, reference).leaked, true);
});

test('code is found in fenced blocks and inline spans of the text, never in plain words', () => {
  assert.deepEqual(hintLeak.codeInText('先看 `rr()`，再写：\n```c\nint a = 1;\n```\n然后 `b += a;`'), ['int a = 1;\n', 'rr()', 'b += a;']);
  assert.deepEqual(hintLeak.codeInText('没有代码，只有文字。'), []);
  assert.equal(hintLeak.addedLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context'), 'new');
});

test('copiedShare: the share of the code in runs of three or more lines matching what was shown', () => {
  const shown = 'int total = 0;\nfor (int i = 0; i < n; i++) total += values[i];\nreturn total / n;';
  // The same three lines renamed and reformatted, plus three of the developer's own.
  const code = [
    'int sum = 0;',
    'for (int k = 0; k < count; k++)   sum += xs[k];',
    'return sum / count;',
    'printf("%d\\n", sum);',
    'if (count == 0) return -1;',
    'free(xs);',
  ].join('\n');
  assert.equal(hintLeak.copiedShare(code, [shown]), 0.5);
  // Two matching lines are no run.
  assert.equal(hintLeak.copiedShare('int sum = 0;\nfor (int k = 0; k < count; k++) sum += xs[k];\nfree(xs);', [shown]), 0);
  // Overlapping runs from several pieces count each line once.
  assert.equal(hintLeak.copiedShare(shown, [shown, shown]), 1);
  assert.equal(hintLeak.copiedShare('', [shown]), 0);
  assert.equal(hintLeak.copiedShare(code, []), 0);
});

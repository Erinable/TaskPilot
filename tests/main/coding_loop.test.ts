import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as loop from '../../src/main/coding_loop.ts';
import { MAX_AUTO_ATTEMPTS } from '../../src/shared/coding_types.ts';

const file = (path: string, highRisk = false) => ({ path, added: 1, removed: 0, binary: false, highRisk });

test('the developer round plus three automatic rounds, shared by checks and QA', () => {
  assert.equal(MAX_AUTO_ATTEMPTS, 3);
  assert.equal(loop.canRetry({ attempt: 1 }), true);
  assert.equal(loop.canRetry({ attempt: 3 }), true);
  assert.equal(loop.canRetry({ attempt: 4 }), false);
});

test('autoApply() stops on any high-risk file and leaves blocked files out', () => {
  assert.deepEqual(loop.autoApply({ files: [file('src/a.ts'), file('package.json', true)], blocked: [] }), { files: [], highRisk: true });
  assert.deepEqual(loop.autoApply({ files: [file('src/a.ts'), file('src/b.ts')], blocked: [{ path: 'src/b.ts', reason: 'outside requested file scope' }] }), {
    files: ['src/a.ts'],
    highRisk: false,
  });
});

test('checksFeedback() names the failing tests and keeps only the output tail', () => {
  const text = loop.checksFeedback([
    {
      evidence: { kind: 'test', status: 'fail', reason: 'new_failures', newFailures: ['logs in'] },
      run: { command: 'npm run test', exitCode: 1, timedOut: false, output: `${'x'.repeat(10_000)}END` },
    },
  ]);
  assert.match(text, /## test: new_failures/);
  assert.match(text, /New failures: logs in/);
  assert.ok(text.endsWith('END'));
  assert.ok(text.length < 5000);
});

test('reviewFeedback() lists QA issues with locations and unmet criteria', () => {
  const text = loop.reviewFeedback({
    reasons: ['qa_rejected'],
    report: {
      verdict: 'reject',
      summary: '缺少错误处理',
      criteria: [{ index: 0, status: 'unmet', note: '没有提示' }],
      issues: [{ severity: 'major', text: '未处理空输入', file: 'src/a.ts', line: 12 }],
    },
    checks: [],
  });
  assert.match(text, /\[major\] src\/a\.ts:12 未处理空输入/);
  assert.match(text, /Acceptance criterion 1 is unmet: 没有提示/);
});

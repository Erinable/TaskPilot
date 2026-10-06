import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as model from '../../src/renderer/src/lib/review_model.ts';
import { describeErrorInfo } from '../../src/renderer/src/lib/errors.ts';
import { inlineCodeParts } from '../../src/renderer/src/lib/inline_code.ts';
import * as evidence from '../../src/main/evidence.ts';
import type * as ipc from '../../src/shared/ipc_types.ts';

const baseline = (overrides: Partial<ipc.BaselineChecks>): ipc.BaselineChecks => ({
  status: 'measured', reason: null, commit: 'abc', checks: {}, startedAt: '', finishedAt: null, ...overrides,
});

test('baselineText() explains each state and when re-measuring helps', () => {
  assert.deepEqual(model.baselineText(null), { text: '', canRemeasure: false });
  const record: ipc.BaselineCheckRecord = { status: 'measured', line: '', exitCode: 1, timedOut: false, crashed: false, reportProblem: null, failing: ['a', 'b'], passing: [], at: '' };
  const measured = model.baselineText(baseline({ checks: { test: record } }));
  assert.match(measured.text, /2 个测试在基线上就失败/);
  assert.equal(measured.canRemeasure, false);
  assert.equal(model.baselineText(baseline({ status: 'unavailable', reason: 'dirty_tree' })).canRemeasure, true);
  assert.equal(model.baselineText(baseline({ status: 'unavailable', reason: 'no_checks' })).canRemeasure, false);
  assert.equal(model.baselineText(baseline({ status: 'contaminated' })).canRemeasure, true);
  assert.match(model.baselineText(baseline({ status: 'unavailable', reason: 'something_new' })).text, /something_new/);
});

test('evidenceLine() names the check, the reason, and advisory checks', () => {
  const line = model.evidenceLine({ kind: 'smoke', status: 'fail', reason: 'crashed', blocking: false });
  assert.equal(line.text, '冒烟测试 失败 · 命令异常退出，没有解析到测试结果 · 仅提示，不阻断');
  assert.equal(line.tone, 'blocked');
  assert.equal(model.evidenceLine({ kind: 'test', status: 'pass', reason: null, blocking: true }).text, '测试 通过');
});

test('attentionText() covers every attention code evidence.ts emits', () => {
  const acceptance = [{ text: '成功返回 token' }];
  const items: ipc.AttentionItem[] = [
    { code: 'check_unverifiable', kind: 'test', reason: 'report_missing', blocking: true },
    { code: 'preexisting_failures', kind: 'test', count: 3 },
    { code: 'no_baseline', kind: 'test' },
    { code: 'criterion_unverifiable', index: 0 },
    { code: 'criterion_manual', index: 0 },
    { code: 'criterion_already_passing', index: 0 },
  ];
  for (const item of items) assert.notEqual(model.attentionText(item, acceptance), item.code, `${item.code} has no wording`);
  assert.match(model.attentionText({ code: 'criterion_manual', index: 0 }, acceptance), /「成功返回 token」/);
});

test('every evidence reason has wording', () => {
  const source = fs.readFileSync(new URL('../../src/main/evidence.ts', import.meta.url), 'utf8');
  const reasons = [...source.matchAll(/done\('(?:fail|unverifiable|pass)', '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 6);
  assert.ok(evidence.evaluate);
  for (const reason of reasons) assert.ok(model.REASONS[reason], `missing wording for ${reason}`);
  for (const problem of ['missing', 'stale', 'not_a_file', 'outside', 'too_large', 'invalid']) {
    assert.ok(model.REASONS[`report_${problem}`], `missing wording for report_${problem}`);
  }
});

test('criterionRows() prefers evidence status, then legacy flags, then manual/pending', () => {
  const acceptance = [{ text: 'a', test: 'ta' }, { text: 'b', test: 'tb' }, { text: 'c' }, { text: 'd', test: 'td' }];
  const matched = [
    { text: 'a', test: 'ta', status: 'verified', verified: true, manual: false, alreadyPassing: true },
    // Stored before statuses existed: only the flags.
    { text: 'b', test: 'tb', verified: false, manual: false, missing: true },
  ] as ipc.CriterionEvidence[];
  const rows = model.criterionRows(acceptance, matched);
  assert.deepEqual(rows.map((row) => [row.status, row.tone, row.icon]), [
    ['verified', 'verified', 'check-circle'],
    ['missing', 'failed', 'x-circle'],
    ['manual', '', 'circle'],
    [null, '', 'circle'],
  ]);
  assert.equal(rows[0].alreadyPassing, true);
  assert.equal(rows[3].note, '待验证');
});

test('inlineCodeParts() splits backticks and drops empty parts', () => {
  assert.deepEqual(inlineCodeParts('call `login()` now'), [
    { text: 'call ', code: false }, { text: 'login()', code: true }, { text: ' now', code: false },
  ]);
  assert.deepEqual(inlineCodeParts('`x`'), [{ text: 'x', code: true }]);
});

test('diffLineKind() treats git headers as meta, not additions or deletions', () => {
  assert.equal(model.diffLineKind('--- a/x.js'), 'meta');
  assert.equal(model.diffLineKind('+++ b/x.js'), 'meta');
  assert.equal(model.diffLineKind('new file mode 100644'), 'meta');
  assert.equal(model.diffLineKind('@@ -1 +1 @@'), 'hunk');
  assert.equal(model.diffLineKind('+added'), 'add');
  assert.equal(model.diffLineKind('-removed'), 'del');
  assert.equal(model.diffLineKind(' context'), '');
});

test('resolutionTitle() and describeErrorInfo() word plain IPC objects', () => {
  const resolution: ipc.DeviationResolution = { decision: 'replan', reason: '', changes: [], decidedAt: '', afterContest: true, contested: false, reverted: true };
  assert.equal(model.resolutionTitle(resolution), 'Architect 已重新规划（应你的异议） · 你已撤销');
  assert.equal(describeErrorInfo({ code: 'agent_timeout', message: 'x' }), '智能体超过 3 分钟没有完成，已停止。');
  assert.equal(describeErrorInfo({ code: 'weird', message: 'raw' }), 'raw');
});

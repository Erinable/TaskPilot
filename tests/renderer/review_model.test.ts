import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as model from '../../src/renderer/src/lib/review_model.ts';
import { describeErrorInfo } from '../../src/renderer/src/lib/errors.ts';
import { inlineCodeParts } from '../../src/renderer/src/lib/inline_code.ts';
import * as evidence from '../../src/main/evidence.ts';
import type * as packageTypes from '../../src/shared/ipc/packages.ts';
import type * as workspaceTypes from '../../src/shared/ipc/workspace.ts';

const baseline = (overrides: Partial<workspaceTypes.BaselineChecks>): workspaceTypes.BaselineChecks => ({
  status: 'measured',
  reason: null,
  commit: 'abc',
  checks: {},
  startedAt: '',
  finishedAt: null,
  ...overrides,
});

test('baselineText() explains each state and when re-measuring helps', () => {
  assert.deepEqual(model.baselineText(null), { text: '', canRemeasure: false });
  const record: workspaceTypes.BaselineCheckRecord = {
    status: 'measured',
    line: '',
    exitCode: 1,
    timedOut: false,
    crashed: false,
    reportProblem: null,
    failing: ['a', 'b'],
    passing: [],
    at: '',
  };
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
  const items: workspaceTypes.AttentionItem[] = [
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
  const check: evidence.EvidenceCheck = { kind: 'test', stage: 'submit', blocking: true };
  const run = { results: [], exitCode: 0, timedOut: false };
  const failed = { ...run, exitCode: 1, results: [{ name: 'test', passed: false, skipped: false, todo: false }] };
  const crashed = { ...run, exitCode: 1 };
  const timedOut = { ...crashed, timedOut: true };
  const cases: [Parameters<typeof evidence.evaluate>[1], evidence.BaselineRecord | null, string][] = [
    [failed, null, 'no_baseline'],
    [failed, evidence.baselineRecord(run, 'npm test'), 'new_failures'],
    [failed, evidence.baselineRecord(failed, 'npm test'), 'preexisting_only'],
    [crashed, null, 'crashed'],
    [crashed, evidence.baselineRecord(crashed, 'npm test'), 'broken_at_baseline'],
    [timedOut, null, 'timed_out'],
    [timedOut, evidence.baselineRecord(timedOut, 'npm test'), 'timed_out_at_baseline'],
    [{ error: { code: 'command_missing' } }, null, 'command_missing'],
  ];
  for (const problem of ['missing', 'stale', 'not_a_file', 'outside', 'too_large', 'invalid'] as const) {
    cases.push([{ ...run, report: { format: 'junit', trusted: false, problem } }, null, `report_${problem}`]);
  }
  for (const [outcome, baseline, reason] of cases) {
    const item = evidence.evaluate(check, outcome, baseline);
    assert.equal(item.reason, reason);
    assert.ok(model.REASONS[reason], `missing wording for ${reason}`);
    assert.ok(model.evidenceLine(item).text.includes(model.REASONS[reason]), `missing rendered wording for ${reason}`);
  }
});

test('criterionRows() prefers evidence status, then legacy flags, then manual/pending', () => {
  const acceptance = [{ text: 'a', test: 'ta' }, { text: 'b', test: 'tb' }, { text: 'c' }, { text: 'd', test: 'td' }];
  const matched = [
    { text: 'a', test: 'ta', status: 'verified', verified: true, manual: false, alreadyPassing: true },
    // Stored before statuses existed: only the flags.
    { text: 'b', test: 'tb', verified: false, manual: false, missing: true },
  ] as workspaceTypes.CriterionEvidence[];
  const rows = model.criterionRows(acceptance, matched);
  assert.deepEqual(
    rows.map((row) => [row.status, row.tone, row.icon]),
    [
      ['verified', 'verified', 'check-circle'],
      ['missing', 'failed', 'x-circle'],
      ['manual', '', 'circle'],
      [null, '', 'circle'],
    ],
  );
  assert.equal(rows[0].alreadyPassing, true);
  assert.equal(rows[3].note, '待验证');
});

test('inlineCodeParts() splits backticks and drops empty parts', () => {
  assert.deepEqual(inlineCodeParts('call `login()` now'), [
    { text: 'call ', code: false },
    { text: 'login()', code: true },
    { text: ' now', code: false },
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
  const resolution: packageTypes.DeviationResolution = {
    decision: 'replan',
    reason: '',
    changes: [],
    decidedAt: '',
    afterContest: true,
    contested: false,
    reverted: true,
  };
  assert.equal(model.resolutionTitle(resolution), 'Architect 已重新规划（应你的异议） · 你已撤销');
  assert.equal(describeErrorInfo({ code: 'agent_timeout', message: 'x' }), '智能体超过 3 分钟没有完成，已停止。');
  assert.equal(describeErrorInfo({ code: 'weird', message: 'raw' }), 'raw');
});

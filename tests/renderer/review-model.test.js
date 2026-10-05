const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/renderer/review-model');

test('baselineText() explains each state and when re-measuring helps', () => {
  assert.deepEqual(model.baselineText(null), { text: '', canRemeasure: false });
  const measured = model.baselineText({ status: 'measured', checks: { test: { failing: ['a', 'b'] } } });
  assert.match(measured.text, /2 个测试在基线上就失败/);
  assert.equal(measured.canRemeasure, false);
  assert.equal(model.baselineText({ status: 'unavailable', reason: 'dirty_tree' }).canRemeasure, true);
  assert.equal(model.baselineText({ status: 'unavailable', reason: 'no_checks' }).canRemeasure, false);
  assert.equal(model.baselineText({ status: 'contaminated' }).canRemeasure, true);
  assert.match(model.baselineText({ status: 'unavailable', reason: 'something_new' }).text, /something_new/);
});

test('evidenceLine() names the check, the reason, and advisory checks', () => {
  const line = model.evidenceLine({ kind: 'smoke', status: 'fail', reason: 'crashed', blocking: false });
  assert.equal(line.text, '冒烟测试 失败 · 命令异常退出，没有解析到测试结果 · 仅提示，不阻断');
  assert.equal(line.tone, 'blocked');
  assert.equal(model.evidenceLine({ kind: 'test', status: 'pass', reason: null, blocking: true }).text, '测试 通过');
});

test('attentionText() covers every attention code evidence.js emits', () => {
  const acceptance = [{ text: '成功返回 token' }];
  const codes = ['check_unverifiable', 'preexisting_failures', 'no_baseline', 'criterion_unverifiable', 'criterion_manual', 'criterion_already_passing'];
  for (const code of codes) {
    const text = model.attentionText({ code, kind: 'test', reason: 'report_missing', count: 3, index: 0 }, acceptance);
    assert.notEqual(text, code, `${code} has no wording`);
  }
  assert.match(model.attentionText({ code: 'criterion_manual', index: 0 }, acceptance), /「成功返回 token」/);
});

test('every evidence reason has wording', () => {
  const evidence = require('../../src/evidence');
  const source = require('node:fs').readFileSync(require.resolve('../../src/evidence'), 'utf8');
  const reasons = [...source.matchAll(/done\('(?:fail|unverifiable|pass)', '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 6);
  assert.ok(evidence.evaluate);
  for (const reason of reasons) assert.ok(model.REASONS[reason], `missing wording for ${reason}`);
  for (const problem of ['missing', 'stale', 'not_a_file', 'outside', 'too_large', 'invalid']) {
    assert.ok(model.REASONS[`report_${problem}`], `missing wording for report_${problem}`);
  }
});

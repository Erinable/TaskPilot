import { test } from 'vitest';
import assert from 'node:assert/strict';
import { check } from '../../evals/product-lead/checks.ts';
import { cases, answerFor } from '../../evals/product-lead/fixtures.ts';
import * as productLead from '../../src/main/agents/product_lead.ts';

const files = ['src/auth/user-repository.ts', 'tests/auth/user-repository.test.ts', 'package.json'];
const pkg = (overrides = {}) => ({
  title: 'p', estimateHours: 1,
  fileScope: ['src/auth/user-repository.ts', 'tests/auth/user-repository.test.ts'],
  acceptance: [{ text: 'a', test: 'finds by email' }],
  ...overrides,
});
const testCase = (expect = {}): any => ({
  files,
  expect: { questions: [0, 1], packages: [1, 2], hours: [0.5, 3], ...expect },
});
const run = (packages, questions: string[] = []): any => ({ clarify: { questions }, answers: [], plan: { summary: 's', packages } });
const failing = (results: Record<string, { pass: boolean }>) => Object.entries(results).filter(([, r]) => !r.pass).map(([name]) => name);

test('a grounded, well-sized plan passes every check', () => {
  assert.deepEqual(failing(check(testCase({ mustTouch: ['src/auth/user-repository.ts'] }), run([pkg()]))), []);
});

test('count and size checks catch over-asking and over-splitting', () => {
  const many = Array.from({ length: 5 }, (_, i) => pkg({ estimateHours: 5, fileScope: [`src/auth/f${i}.ts`], acceptance: [{ text: 'a', test: `t${i}` }] }));
  const result = check(testCase(), run(many, ['a', 'b', 'c']));
  assert.ok(failing(result).includes('questionCount'));
  assert.ok(failing(result).includes('packageCount'));
  assert.ok(failing(result).includes('packageSize'));
  assert.ok(failing(result).includes('totalHours'));
});

test('grounding flags files in directories the repo does not have', () => {
  const result = check(testCase(), run([pkg({ fileScope: ['lib/server/http/login.ts'] })]));
  assert.equal(result.grounded.pass, false);
  // One new level under an existing directory is fine.
  assert.equal(check(testCase(), run([pkg({ fileScope: ['src/auth/application/login.ts'] })])).grounded.pass, true);
});

test('test convention flags __tests__ in a tests/ repo, and honours an explicit pattern', () => {
  const offConvention = check(testCase(), run([pkg({ fileScope: ['src/auth/__tests__/login.test.ts'] })]));
  assert.equal(offConvention.testConvention.pass, false);
  const onConvention = check(testCase(), run([pkg({ fileScope: ['tests/auth/login.test.ts'] })]));
  assert.equal(onConvention.testConvention.pass, true);
  const pattern = check(testCase({ testPattern: /__tests__\// }), run([pkg({ fileScope: ['tests/auth/login.test.ts'] })]));
  assert.equal(pattern.testConvention.pass, false);
});

test('overlap tolerates one shared file but not more', () => {
  const two = [pkg({ fileScope: ['a.ts', 'b.ts'] }), pkg({ fileScope: ['a.ts', 'c.ts'], acceptance: [{ text: 'x', test: 'other' }] })];
  assert.equal(check(testCase(), run(two)).overlap.pass, true);
  const three = [pkg({ fileScope: ['a.ts', 'b.ts'] }), pkg({ fileScope: ['a.ts', 'b.ts'], acceptance: [{ text: 'x', test: 'other' }] })];
  assert.equal(check(testCase(), run(three)).overlap.pass, false);
});

test('testable, unique tests, and invention checks', () => {
  const result = check(testCase({ mustNotInvent: ['session'] }), run([
    pkg({ acceptance: [{ text: 'no test' }] }),
    pkg({ title: 'q', acceptance: [{ text: 'Session cookie set', test: 'dup' }] }),
    pkg({ title: 'r', acceptance: [{ text: 'b', test: 'dup' }] }),
  ]));
  assert.equal(result.testable.pass, false);
  assert.equal(result.uniqueTests.pass, false);
  assert.equal(result.noInvention.pass, false);
});

test('no-repo cases skip grounding checks', () => {
  const result = check({ files: [], expect: { questions: [0, 3], packages: [1, 2], hours: [1, 4] } } as any, run([pkg({ fileScope: ['anywhere/x.js'] })]));
  assert.equal(result.grounded, undefined);
  assert.equal(result.testConvention, undefined);
});

test('codeGrounding passes at two thirds of the terms and sees through JSON escaping', () => {
  const steps = (text) => run([pkg({ steps: [text] })]);
  const terms = { grounding: ['fakeDb', 'route(', 'variant="danger"'] };
  assert.equal(check(testCase(terms), steps('用 `fakeDb` 和 `route(` 注册')).codeGrounding.pass, true);
  assert.equal(check(testCase(terms), steps('传入 variant="danger"')).codeGrounding.pass, false);
  assert.match(check(testCase(terms), steps('variant="danger" 和 fakeDb')).codeGrounding.detail, /^2\/3 missing route\(/);
});

test('fixtures are well-formed and their must-touch files exist', () => {
  const ids = new Set();
  for (const c of cases) {
    assert.ok(!ids.has(c.id), `duplicate case ${c.id}`);
    ids.add(c.id);
    assert.ok([...c.requirement.text].length <= 4000);
    for (const file of c.expect.mustTouch ?? []) assert.ok(c.files.includes(file), `${c.id}: ${file} not in files`);
    for (const file of Object.keys(c.sources!)) assert.ok(c.files.includes(file), `${c.id}: source ${file} not in files`);
    // Grounding terms must actually be in the code, or the check is unfair.
    const code = Object.values(c.sources!).join('\n');
    for (const term of c.expect.grounding ?? []) {
      if (term === 'variant="danger"') continue; // the fix itself, not existing code
      assert.ok(code.includes(term), `${c.id}: grounding term ${term} not in sources`);
    }
    for (const file of c.files) assert.doesNotThrow(() => productLead.scopePath(file, file));
  }
});

test('answerFor() matches by keyword and falls back to the default', () => {
  const login = cases.find((c) => c.id === 'login-typical')!;
  assert.match(answerFor(login, '登录成功后用 JWT 还是 Session？'), /TokenService/);
  assert.match(answerFor(login, '连续失败几次后锁定？'), /不做锁定/);
  assert.equal(answerFor(login, '别的问题'), login.answers.default);
  assert.equal(answerFor({ answers: {} }, 'x'), '');
});

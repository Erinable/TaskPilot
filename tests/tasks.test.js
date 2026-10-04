const test = require('node:test');
const assert = require('node:assert/strict');
const { PRIORITIES, isStatus, listTasks, getTask, checkFileScope, scopeEscapesRoot } = require('../src/tasks');

test('every task has the fields the renderer depends on', () => {
  const tasks = listTasks();
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    for (const field of ['id', 'title', 'description', 'intro', 'module', 'estimate', 'icon']) {
      assert.equal(typeof task[field], 'string', `${task.id}.${field}`);
      assert.ok(task[field].length > 0, `${task.id}.${field} is empty`);
    }
    assert.ok(PRIORITIES.includes(task.priority), `${task.id} has unknown priority ${task.priority}`);
    assert.ok(isStatus(task.status), `${task.id} has unknown status ${task.status}`);
    assert.ok(task.tags.length > 0, `${task.id} has no tags`);
    assert.ok(task.steps.length > 0, `${task.id} has no steps`);
    assert.ok(task.fileScope.length > 0, `${task.id} has no file scope`);
    assert.ok(task.acceptance.length > 0, `${task.id} has no acceptance criteria`);
    for (const criterion of task.acceptance) {
      assert.equal(typeof criterion.text, 'string', `${task.id} criterion missing text`);
      assert.ok(criterion.text.length > 0, `${task.id} criterion text is empty`);
      if ('test' in criterion) {
        assert.ok(criterion.test.length > 0, `${task.id} criterion has an empty test name`);
      }
    }
  }
});

test('definitions only carry pre-claim statuses', () => {
  // Anything from in_progress onward needs a baseline commit, which is
  // per-machine and only recorded by the store when a human claims it.
  const preClaim = ['clarifying', 'pending'];
  for (const task of listTasks()) {
    assert.ok(preClaim.includes(task.status), `${task.id} is seeded as ${task.status}`);
  }
});

test('getTask() finds by id and returns null otherwise', () => {
  assert.equal(getTask('auth-email-login').title, '实现邮箱登录接口');
  assert.equal(getTask('nope'), null);
});

test('checkFileScope() splits changed paths into in and out of scope', () => {
  const task = getTask('auth-edge-tests'); // scope: tests/auth/login-user.test.ts
  const result = checkFileScope(task, ['tests/auth/login-user.test.ts', 'src/unrelated.ts']);
  assert.deepEqual(result.inScope, ['tests/auth/login-user.test.ts']);
  assert.deepEqual(result.outOfScope, ['src/unrelated.ts']);
  assert.deepEqual(result.untouched, []);
});

test('checkFileScope() reports scope entries nobody has touched yet', () => {
  const task = getTask('auth-email-login');
  const result = checkFileScope(task, ['src/auth/application/login-user.ts']);
  assert.deepEqual(result.untouched, ['tests/auth/login-user.test.ts']);
  assert.deepEqual(result.outOfScope, []);
});

test('no sample task declares a file scope outside the workspace root', () => {
  for (const task of listTasks()) {
    assert.deepEqual(scopeEscapesRoot('/repo', task), [], `${task.id} escapes the root`);
  }
});

test('scopeEscapesRoot() catches a traversal attempt in a scope entry', () => {
  const task = { fileScope: ['src/ok.ts', '../../etc/passwd'] };
  assert.deepEqual(scopeEscapesRoot('/repo', task), ['../../etc/passwd']);
});

test('task ids are unique', () => {
  const ids = listTasks().map((task) => task.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('inline code markers in steps are balanced', () => {
  for (const task of listTasks()) {
    for (const step of task.steps) {
      const backticks = step.split('`').length - 1;
      assert.equal(backticks % 2, 0, `${task.id}: unbalanced backticks in "${step}"`);
    }
  }
});

test('listTasks returns a copy that cannot mutate the source', () => {
  const first = listTasks();
  first[0].title = 'mutated';
  first[0].steps.push('extra');
  const second = listTasks();
  assert.notEqual(second[0].title, 'mutated');
  assert.ok(!second[0].steps.includes('extra'));
});

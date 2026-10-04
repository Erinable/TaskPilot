const test = require('node:test');
const assert = require('node:assert/strict');
const { PRIORITIES, listTasks } = require('../src/tasks');

test('every task has the fields the renderer depends on', () => {
  const tasks = listTasks();
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    for (const field of ['id', 'title', 'description', 'intro', 'module', 'estimate', 'icon']) {
      assert.equal(typeof task[field], 'string', `${task.id}.${field}`);
      assert.ok(task[field].length > 0, `${task.id}.${field} is empty`);
    }
    assert.ok(PRIORITIES.includes(task.priority), `${task.id} has unknown priority ${task.priority}`);
    assert.ok(task.tags.length > 0, `${task.id} has no tags`);
    assert.ok(task.steps.length > 0, `${task.id} has no steps`);
    assert.ok(task.acceptance.length > 0, `${task.id} has no acceptance criteria`);
  }
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

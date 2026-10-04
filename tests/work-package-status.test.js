const test = require('node:test');
const assert = require('node:assert/strict');
const status = require('../src/work-package-status');

test('every transition references known statuses', () => {
  for (const transition of status.TRANSITIONS) {
    assert.ok(status.isStatus(transition.from), `unknown from: ${transition.from}`);
    assert.ok(status.isStatus(transition.to), `unknown to: ${transition.to}`);
    assert.ok(['human', 'agent'].includes(transition.actor), `bad actor: ${transition.actor}`);
  }
});

test('transition names are unique per source status', () => {
  const seen = new Set();
  for (const { from, name } of status.TRANSITIONS) {
    const key = `${from}:${name}`;
    assert.ok(!seen.has(key), `duplicate transition ${key}`);
    seen.add(key);
  }
});

test('claim moves a pending package to in_progress', () => {
  assert.equal(status.apply('pending', 'claim', 'human'), 'in_progress');
});

test('rejects a transition that is not allowed from the current status', () => {
  assert.throws(() => status.apply('pending', 'submit_for_review', 'human'), { code: 'not_allowed' });
});

test('rejects a human performing an agent-only transition', () => {
  // Acceptance belongs to the AI team; the developer cannot self-accept.
  assert.throws(() => status.apply('accepting', 'accepted', 'human'), { code: 'wrong_actor' });
});

test('rejects an unknown status', () => {
  assert.throws(() => status.apply('nope', 'claim', 'human'), { code: 'unknown_status' });
});

test('available() narrows transitions by actor', () => {
  const names = status.available('in_progress', 'human').map((t) => t.name);
  assert.deepEqual(names.sort(), ['block', 'release', 'report_deviation', 'submit_for_review']);
  assert.deepEqual(status.available('in_progress', 'agent'), []);
});

test('done is terminal and clarifying is not human-actionable', () => {
  assert.deepEqual(status.available('done'), []);
  assert.equal(status.STATUSES.clarifying.humanActionable, false);
  assert.equal(status.STATUSES.pending.humanActionable, true);
});

test('every status except clarifying is reachable', () => {
  const reachable = new Set(status.TRANSITIONS.map((t) => t.to));
  for (const name of Object.keys(status.STATUSES)) {
    if (name === 'clarifying') continue; // the entry point
    assert.ok(reachable.has(name), `${name} is unreachable`);
  }
});

test('the full happy path runs clarifying through done', () => {
  const path = [
    ['breakdown_done', 'agent'],
    ['claim', 'human'],
    ['submit_for_review', 'human'],
    ['review_passed', 'agent'],
    ['accepted', 'agent'],
  ];
  let current = 'clarifying';
  for (const [name, actor] of path) current = status.apply(current, name, actor);
  assert.equal(current, 'done');
});

test('a reported deviation can be replanned back to pending', () => {
  let current = status.apply('in_progress', 'report_deviation', 'human');
  assert.equal(current, 'deviation');
  current = status.apply(current, 'replanned', 'agent');
  assert.equal(current, 'pending');
});

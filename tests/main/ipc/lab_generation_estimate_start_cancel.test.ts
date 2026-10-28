import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as lab from './lab_generation_fixtures.ts';
import * as goals from '../../fixtures/course_interview.ts';

vi.setConfig({ testTimeout: 20_000 });

const confirmedCourse = lab.confirmedCourse;
const settleLab = lab.settleLab;

// Estimate, start and cancellation behavior stays independent from the draft's private shape.
test('the estimate names the first concept to learn, counts the self-check in and runs no model', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await confirmedCourse(h);
  const calls = h.agentCalls.length;
  const { data, error } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(error, undefined);
  assert.deepEqual(data.concepts, [{ id: 'round-robin', label: '时间片轮转（RR）' }]);
  assert.equal(data.difficulty, 'easy');
  assert.equal(data.calls, 4);
  assert.equal(data.maxCalls, 10);
  assert.ok(data.tokens.input > 10_000 && data.tokens.output >= 300_000, JSON.stringify(data.tokens));
  assert.equal(data.usd, null);
  assert.equal(h.agentCalls.length, calls);
});

test('the estimate prices the tokens with the synced price table', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await confirmedCourse(h);
  const prefs = fixtures.validPrefs();
  const saved = await h.call(CHANNELS.preferencesSet, {
    ...prefs,
    agents: { ...prefs.agents, tutor: { cli: 'claude', model: 'claude-opus-5-5', thinking: 'default' } },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  await fs.writeFile(
    `${h.configDir}/model_prices.json`,
    JSON.stringify({ syncedAt: '2026-10-27T00:00:00Z', exact: { anthropic: { 'claude-opus-5-5': [5, 25, 0.5, 6.25] } }, firstParty: {} }),
  );
  const { data } = await h.call(CHANNELS.requirementsLabEstimate, id);
  assert.equal(data.model, 'claude-opus-5-5');
  assert.ok(data.usd.low > 2.5 && data.usd.low < 4 && data.usd.high > 7 && data.usd.high < 13, JSON.stringify(data.usd));
});

test('a lab is only generated for a confirmed course path', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '想学操作系统的进程调度', course: goals.GOAL_FORM });
  await h.idle();
  assert.equal((await h.call(CHANNELS.requirementsLabEstimate, data.id)).error.code, 'invalid_state');
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, data.id)).error.code, 'invalid_state');
  const project = (await h.call(CHANNELS.requirementsCreate, { text: '邮箱登录' })).data;
  assert.equal((await h.call(CHANNELS.requirementsLabGenerate, project.id)).error.code, 'invalid_state');
});

test('cancelling stops the run before the code call lands, and a retry starts over', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await lab.harness({ agent: lab.team({ gate }) });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await fixtures.until(
    async () => (await h.call(CHANNELS.requirementsGet, id)).data.course.lab.phase,
    (phase) => phase === 'code',
    'lab generation code phase',
  );
  assert.equal((await h.call(CHANNELS.repositoriesBusy)).data[0].kind, 'requirement');
  assert.equal((await h.call(CHANNELS.requirementsCancel, id)).data, true);
  release();
  const item = await settleLab(h, id);
  assert.equal(item.course.lab.status, 'failed');
  assert.equal(item.course.lab.error.code, 'agent_cancelled');
  await h.call(CHANNELS.requirementsLabGenerate, id);
  assert.equal((await settleLab(h, id)).course.lab.status, 'ready');
});

test('a lab interrupted by a quit is failed on the next load', async () => {
  const h = await lab.harness({ agent: lab.team() });
  const id = await confirmedCourse(h);
  await h.call(CHANNELS.requirementsLabGenerate, id);
  await settleLab(h, id);
  const file = `${h.repoDir}/requirements.json`;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.items.find((item) => item.id === id).course.lab.status = 'running';
  await fs.writeFile(file, JSON.stringify(saved));
  await h.requirements.open(h.repoDir);
  const current = h.requirements.get(id).course?.lab;
  assert.ok(current);
  assert.equal(current.status, 'failed');
  assert.equal(current.error?.code, 'agent_interrupted');
});

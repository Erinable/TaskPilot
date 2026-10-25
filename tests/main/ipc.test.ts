// The IPC boundary as a whole: every channel is registered and every handler answers with a result.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from './fixtures/sample_tasks.ts';
import * as fixtures from './ipc/harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('preload exposes every channel the main process registers', async () => {
  // The preload shares CHANNELS with the main process; guard against a
  // channel being registered but never exposed to the renderer.
  const preload = await fs.readFile(path.join(import.meta.dirname, '..', '..', 'src', 'preload', 'index.ts'), 'utf8');
  for (const key of Object.keys(CHANNELS)) {
    assert.ok(new RegExp(`CHANNELS\\.${key}\\b`).test(preload), `preload/index.ts does not reference CHANNELS.${key}`);
  }
});

test('handlers return {ok:true,data} instead of throwing', async () => {
  const { call } = await fixtures.harness();
  const response = await call(CHANNELS.listTasks);
  assert.equal(response.ok, true);
  assert.equal(response.data.length, SAMPLE_TASKS.length);
});

test('errors come back as {ok:false,error} with a code', async () => {
  const { call } = await fixtures.harness();
  const response = await call(CHANNELS.getTask, 'nope');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unknown_package');
  const blank = await call(CHANNELS.getTask, '   ');
  assert.equal(blank.error.code, 'invalid_argument');
});

test('role settings are independent and frozen across an in-flight requirement', async () => {
  const selected = Promise.withResolvers<void>();
  const continueSelection = Promise.withResolvers<void>();
  let firstSelection = true;
  const agent: fixtures.FakeAgent = async (options) => {
    const step = fixtures.stepOf(options.schema);
    if (step === 'select' && firstSelection) {
      firstSelection = false;
      selected.resolve();
      await continueSelection.promise;
    }
    if (step === 'summarize') {
      return {
        output: { ...fixtures.SUMMARY_OUTPUT, conventions: [options.model === 'architecture-old' ? 'old convention' : 'new convention'] },
        costUsd: null,
      };
    }
    if (step === 'clarify') {
      return { output: { ...fixtures.CLARIFY_OUTPUT, title: options.model === 'product-old' ? '旧产品配置' : '新产品配置' }, costUsd: null };
    }
    return fixtures.fakeAgent()(options);
  };
  const h = await fixtures.harness({ agent });
  const firstProfiles = fixtures.validPrefs();
  firstProfiles.agents.architect = { cli: 'pi', model: 'architecture-old', thinking: 'high' };
  firstProfiles.agents['product-lead'] = { cli: 'grok', model: 'product-old', thinking: 'low' };
  assert.equal((await h.call(CHANNELS.preferencesSet, firstProfiles)).ok, true);
  const originalFinish = h.requirements.finishClarify.bind(h.requirements);
  let completed = Promise.withResolvers<void>();
  vi.spyOn(h.requirements, 'finishClarify').mockImplementation(async (...args) => {
    const result = await originalFinish(...args);
    completed.resolve();
    return result;
  });
  const first = await h.call(CHANNELS.requirementsCreate, { text: '需求一' });
  await selected.promise;
  const nextProfiles = fixtures.validPrefs();
  nextProfiles.agents.architect = { cli: 'claude', model: 'architecture-new', thinking: 'medium' };
  nextProfiles.agents['product-lead'] = { cli: 'pi', model: 'product-new', thinking: 'xhigh' };
  assert.equal((await h.call(CHANNELS.preferencesSet, nextProfiles)).ok, true);
  continueSelection.resolve();
  await completed.promise;
  const firstResult = (await h.call(CHANNELS.requirementsGet, first.data.id)).data;
  assert.equal(firstResult.title, '旧产品配置');
  assert.match(firstResult.interfaces.text, /old convention/);
  completed = Promise.withResolvers<void>();
  const second = await h.call(CHANNELS.requirementsCreate, { text: '需求二' });
  await completed.promise;
  const secondResult = (await h.call(CHANNELS.requirementsGet, second.data.id)).data;
  assert.equal(secondResult.title, '新产品配置');
  assert.match(secondResult.interfaces.text, /new convention/);
  assert.equal((await h.call(CHANNELS.preferencesGet)).data.agents.qa.cli, 'claude');
});

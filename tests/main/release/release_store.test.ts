import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { ReleaseStore, RELEASES_FILENAME, MAX_HISTORY, MAX_NOTES_TEXT } from '../../../src/main/release/release_store.ts';
import type { ReleasePlan } from '../../../src/main/agents/release_manager.ts';

const PLAN: ReleasePlan = {
  bump: 'minor',
  reason: '新增功能',
  currentVersion: '1.0.0',
  nextVersion: '1.1.0',
  notes: { added: ['支持导出'], fixed: [], changed: [], notes: [] },
  checklist: [
    { text: '检查导出', evidence: ['src/export.ts'] },
    { text: '检查文档', evidence: [] },
  ],
};
const INPUT = { commitCount: 2, commitsTruncated: false, fileCount: 1, filesTruncated: false, packageIds: ['wp1'] };

const makeStore = async () => {
  const dir = await tempDir('taskpilot-releases-');
  let counter = 0;
  const open = () => new ReleaseStore(dir, { newId: () => `rel-${(counter += 1)}` }).load();
  return { dir, open, store: await open() };
};

const ready = async (store: ReleaseStore) => {
  await store.begin({ startCommit: 'a'.repeat(40), endCommit: 'b'.repeat(40) });
  return store.complete(PLAN, INPUT, 0.03);
};

test('a completed draft persists with notes rendered from the plan', async () => {
  const { store, open } = await makeStore();
  const draft = await ready(store);
  assert.equal(draft.status, 'ready');
  assert.equal(draft.notesText, '### 新增\n\n- 支持导出');
  const reloaded = (await open()).draft();
  assert.deepEqual(reloaded, draft);
});

test('a draft generating when the app quit loads as interrupted', async () => {
  const { store, open } = await makeStore();
  await store.begin({ startCommit: 'a'.repeat(40), endCommit: 'b'.repeat(40) });
  const draft = (await open()).draft();
  assert.equal(draft?.status, 'failed');
  assert.equal(draft?.error?.code, 'agent_interrupted');
});

test('only one run at a time; a ready or failed draft can be replaced', async () => {
  const { store } = await makeStore();
  await store.begin({ startCommit: 'a'.repeat(40), endCommit: 'b'.repeat(40) });
  await assert.rejects(store.begin({ startCommit: 'a'.repeat(40), endCommit: 'b'.repeat(40) }), { code: 'invalid_state' });
  await store.failRun({ code: 'agent_timeout', message: 'slow' });
  await ready(store);
  assert.equal((await store.begin({ startCommit: 'c'.repeat(40), endCommit: 'd'.repeat(40) })).status, 'generating');
});

test('update validates notes and checklist indices', async () => {
  const { store } = await makeStore();
  await assert.rejects(store.update({ notes: 'x' }), { code: 'invalid_state' });
  await ready(store);
  assert.equal((await store.update({ notes: '改过的说明\n- 一条', checked: [1, 0, 1] })).checked.join(), '0,1');
  await assert.rejects(store.update({ checked: [2] }), { code: 'invalid_argument' });
  await assert.rejects(store.update({ checked: [0.5] }), { code: 'invalid_argument' });
  await assert.rejects(store.update({ notes: 'x'.repeat(MAX_NOTES_TEXT + 1) }), { code: 'too_long' });
  await assert.rejects(store.update({ notes: 'bad\u0000' }), { code: 'invalid_text' });
  await assert.rejects(store.update({ notes: 3 }), { code: 'invalid_argument' });
  assert.equal(store.draft()?.notesText, '改过的说明\n- 一条');
});

test('finish needs every item ticked, then records the release and clears the draft', async () => {
  const { store, open } = await makeStore();
  await ready(store);
  await store.update({ checked: [0] });
  await assert.rejects(store.finish({ packageIds: ['wp1'] }), { code: 'release_unchecked' });
  await store.update({ checked: [0, 1] });
  const finished = await store.finish({ packageIds: ['wp1'] });
  assert.equal(finished.version, '1.1.0');
  assert.equal(finished.endCommit, 'b'.repeat(40));
  assert.ok(finished.checklist.every((item) => item.checked));
  const reloaded = await open();
  assert.equal(reloaded.draft(), null);
  assert.equal(reloaded.latest()?.id, finished.id);
  assert.equal(reloaded.isReleased('wp1'), true);
  assert.equal(reloaded.isReleased('wp2'), false);
});

test('history keeps the newest releases, but released package ids outlive it', async () => {
  const { store, open } = await makeStore();
  for (let index = 0; index < MAX_HISTORY + 2; index += 1) {
    await ready(store);
    await store.update({ checked: [0, 1] });
    await store.finish({ packageIds: [`wp-${index}`] });
  }
  const history = store.history();
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[0].packageIds[0], `wp-${MAX_HISTORY + 1}`);
  const reopened = await open();
  assert.equal(reopened.isReleased('wp-0'), true);
  assert.equal(reopened.history().length, MAX_HISTORY);
});

test('a corrupt file loads as empty', async () => {
  const { dir } = await makeStore();
  await fs.writeFile(path.join(dir, RELEASES_FILENAME), '{not json');
  const store = await new ReleaseStore(dir).load();
  assert.equal(store.draft(), null);
  assert.deepEqual(store.history(), []);
});

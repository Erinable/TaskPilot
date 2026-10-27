// The review channels (src/main/ipc/mastery.ts): notes that carry concepts
// are due by the business day (Asia/Shanghai here), and the learner's
// verdict moves them through the Leitner boxes, saved in mastery.json.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { MASTERY_FILENAME, MasteryStore } from '../../../src/main/mastery_store.ts';
import * as fixtures from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

// Only Date is faked, so the stores' file writes and timers run as usual.
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

const note = (h, title: string, concepts: string[]) =>
  h.notes.create({ title, body: `${title}。`, category: 'mechanism', course: 'os', concepts, tags: [], source: null });

test('mastery: a note with concepts is due the next business day, by Shanghai midnight rather than UTC midnight', async () => {
  // 2026-10-27 23:30 UTC is 2026-10-28 07:30 in Shanghai.
  at('2026-10-27T23:30:00.000Z');
  const h = await fixtures.harness();
  await note(h, 'RR 入队顺序', ['round-robin']);
  await note(h, '没有知识点', []);
  let list = (await h.call(CHANNELS.masteryReviews)).data;
  assert.deepEqual([list.today, list.due, list.total], ['2026-10-28', [], 1]);
  // 15:59 UTC on the 28th is still the 28th in Shanghai.
  at('2026-10-28T15:59:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReviews)).data.due, []);
  assert.equal((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', true)).error.code, 'not_due');
  // 16:00 UTC is midnight of the 29th in Shanghai, though still the 28th in UTC.
  at('2026-10-28T16:00:00.000Z');
  list = (await h.call(CHANNELS.masteryReviews)).data;
  assert.equal(list.today, '2026-10-29');
  assert.deepEqual(list.due, [{ noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-10-29', title: 'RR 入队顺序', concepts: ['round-robin'] }]);
});

test('mastery: remembered moves a note up a box, forgotten back to box 1, and the schedule is kept in mastery.json', async () => {
  at('2026-10-27T02:00:00.000Z');
  const h = await fixtures.harness();
  await note(h, 'RR 入队顺序', ['round-robin']);
  assert.equal((await h.call(CHANNELS.masteryReview, '没有这条.md', true)).error.code, 'not_reviewable');
  assert.equal((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', 'yes')).error.code, 'invalid_argument');
  at('2026-10-28T02:00:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', true)).data, { noteId: 'RR 入队顺序.md', box: 2, dueDay: '2026-10-31' });
  assert.deepEqual((await h.call(CHANNELS.masteryReviews)).data.due, []);
  at('2026-10-31T02:00:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', false)).data, { noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-11-01' });
  await h.mastery.flush();
  const saved = JSON.parse(await fs.readFile(path.join(h.configDir, MASTERY_FILENAME), 'utf8'));
  assert.deepEqual(saved.reviews, [{ noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-11-01' }]);
  assert.deepEqual([...(await new MasteryStore(h.configDir).load()).reviews().values()], saved.reviews);
});

test('mastery: a deleted note’s schedule is dropped at the next review', async () => {
  at('2026-10-27T02:00:00.000Z');
  const h = await fixtures.harness();
  await note(h, '甲', ['round-robin']);
  await note(h, '乙', ['fcfs']);
  at('2026-10-28T02:00:00.000Z');
  await h.call(CHANNELS.masteryReview, '甲.md', true);
  await h.notes.remove('甲.md');
  await h.call(CHANNELS.masteryReview, '乙.md', true);
  assert.deepEqual([...h.mastery.reviews().keys()], ['乙.md']);
});

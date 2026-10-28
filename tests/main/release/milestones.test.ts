import { test } from 'vitest';
import assert from 'node:assert/strict';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { ReleaseStore } from '../../../src/main/release/release_store.ts';
import { assignRequirement, parseMilestoneInput } from '../../../src/main/release/milestones.ts';
import type { Milestone } from '../../../src/shared/ipc/release.ts';
import type { ReleasePlan } from '../../../src/main/agents/release_manager.ts';

const known = new Set(['r1', 'r2', 'r3']);
const store = async () => {
  const dir = await tempDir('taskpilot-milestones-');
  let n = 0;
  return { dir, releases: await new ReleaseStore(dir, { newId: () => `rel-${(n += 1)}`, now: () => new Date('2026-10-14T08:00:00Z') }).load() };
};

test('parseMilestoneInput() checks the version and date, and drops unknown requirements', () => {
  assert.deepEqual(parseMilestoneInput({ version: ' 0.3.0 ', targetDate: '2026-10-31', requirementIds: ['r1', 'gone', 'r1'] }, known), {
    version: '0.3.0',
    targetDate: '2026-10-31',
    requirementIds: ['r1'],
  });
  assert.equal(parseMilestoneInput({ version: '1.0.0-beta.1', targetDate: '' }, known).targetDate, null);
  for (const bad of [{ version: 'v1' }, { version: '1.0' }, { version: '1.0.0', targetDate: '10/31' }, { version: '1.0.0', targetDate: '2026-13-40' }]) {
    assert.throws(() => parseMilestoneInput(bad, known), { code: 'invalid_argument' }, JSON.stringify(bad));
  }
});

test('assignRequirement() keeps a requirement in one open milestone and never touches released ones', () => {
  const milestone = (id: string, requirementIds: string[], releasedAt: string | null = null): Milestone => ({
    id,
    version: id,
    targetDate: null,
    requirementIds,
    createdAt: '',
    releasedAt,
  });
  const before = [milestone('a', ['r1']), milestone('b', []), milestone('old', ['r1'], '2026-09-01')];
  const moved = assignRequirement(before, 'r1', 'b');
  assert.deepEqual(
    moved.map((item) => item.requirementIds),
    [[], ['r1'], ['r1']],
  );
  assert.deepEqual(
    assignRequirement(moved, 'r1', null).map((item) => item.requirementIds),
    [[], [], ['r1']],
  );
  assert.throws(() => assignRequirement(before, 'r1', 'old'), { code: 'invalid_state' });
  assert.throws(() => assignRequirement(before, 'r1', 'nope'), { code: 'not_found' });
});

test('ReleaseStore milestones: create, edit, reject duplicate versions, delete, and persist', async () => {
  const { dir, releases } = await store();
  const first = await releases.createMilestone({ version: '0.3.0', targetDate: null, requirementIds: ['r1', 'r2'] }, known);
  assert.deepEqual(first.requirementIds, ['r1', 'r2']);
  // A second plan that takes r2 moves it out of the first.
  const second = await releases.createMilestone({ version: '0.4.0', targetDate: '2026-11-30', requirementIds: ['r2'] }, known);
  assert.deepEqual(
    releases.milestones().map((item) => item.requirementIds),
    [['r1'], ['r2']],
  );
  await assert.rejects(() => releases.createMilestone({ version: '0.3.0', requirementIds: [] }, known), { code: 'invalid_argument' });
  await releases.updateMilestone(second.id, { version: '0.4.1', targetDate: null, requirementIds: ['r2', 'r3'] }, known);
  await releases.deleteMilestone(first.id);
  await releases.flush();
  const reloaded = await new ReleaseStore(dir).load();
  assert.deepEqual(
    reloaded.milestones().map((item) => [item.version, item.requirementIds]),
    [['0.4.1', ['r2', 'r3']]],
  );
});

test('finishing a release of a planned version closes that plan', async () => {
  const { releases } = await store();
  await releases.createMilestone({ version: '0.3.0', requirementIds: ['r1'] }, known);
  await releases.begin({ startCommit: 'a', endCommit: 'b' });
  const plan: ReleasePlan = {
    bump: 'minor',
    reason: 'r',
    currentVersion: '0.2.0',
    nextVersion: '0.3.0',
    notes: { added: ['x'], fixed: [], changed: [], notes: [] },
    checklist: [],
  };
  await releases.complete(plan, { commitCount: 1, commitsTruncated: false, fileCount: 1, filesTruncated: false, packageIds: ['r1-wp1'] }, 0);
  await releases.update({ notesText: 'notes' });
  await releases.finish({ packageIds: ['r1-wp1'] });
  const [milestone] = releases.milestones();
  assert.equal(milestone.releasedAt, '2026-10-14T08:00:00.000Z');
  await assert.rejects(() => releases.deleteMilestone(milestone.id), { code: 'invalid_state' });
  // Its version is free for a new plan once released.
  await releases.createMilestone({ version: '0.3.0', requirementIds: [] }, known);
});

import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readCounts } from '../../src/main/repository_summary.ts';
import { countStatuses } from '../../src/shared/repository_counts.ts';

const dataDir = async (files: Record<string, unknown>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-summary-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files))
    await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
};

test('countStatuses buckets statuses the way the sidebar reads them', () => {
  assert.deepEqual(countStatuses(['pending', 'pending', 'in_progress', 'in_review', 'deviation', 'blocked', 'accepting', 'done', 'clarifying']), {
    pending: 2,
    active: 4,
    accepting: 1,
  });
});

test('a closed repository counts its published packages, with saved status over the planned one', async () => {
  const dir = await dataDir({
    'requirements.json': [
      {
        id: 'r1',
        status: 'published',
        packages: [
          { id: 'r1-wp1', status: 'pending' },
          { id: 'r1-wp2', status: 'pending' },
          { id: 'r1-wp3', status: 'pending' },
        ],
      },
      { id: 'r2', status: 'reviewing', packages: [{ id: 'r2-wp1', status: 'pending' }] },
    ],
    'work-packages.json': { 'r1-wp1': { status: 'accepting' }, 'r1-wp2': { status: 'in_progress' }, gone: { status: 'in_progress' } },
  });
  assert.deepEqual(await readCounts(dir), { pending: 1, active: 1, accepting: 1 });
});

test('a repository with no saved data counts nothing, and unreadable data counts as unknown', async () => {
  assert.deepEqual(await readCounts(await dataDir({})), { pending: 0, active: 0, accepting: 0 });
  const errors = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  assert.equal(await readCounts(await dataDir({ 'requirements.json': '{not json' })), null);
});

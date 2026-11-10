import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { NoteStore, LOCATION_FILENAME, IDENTITIES_FILENAME } from '../../../src/main/notes/note_store.ts';
import { TutorStore, TUTOR_FILENAME } from '../../../src/main/work_packages/tutor_store.ts';
import { RepositoryRegistry, REGISTRY_FILENAME } from '../../../src/main/repository/repositories.ts';
import { ActivityLog, EVENTS_DIRNAME } from '../../../src/main/activity/activity_log.ts';
import { ROLLUP_FILENAME } from '../../../src/main/activity/cost_rollup.ts';
import { loadPrices, PRICES_FILENAME } from '../../../src/main/activity/model_prices.ts';
import * as courses from '../../../src/main/courses/courses.ts';
import { labDir, readHints, writePrivate } from '../../../src/main/courses/labs.ts';

const sources: { filename: string; load: (directory: string) => Promise<unknown> }[] = [
  { filename: TUTOR_FILENAME, load: (directory) => new TutorStore(directory).load() },
  { filename: REGISTRY_FILENAME, load: (directory) => new RepositoryRegistry(directory).load() },
  { filename: LOCATION_FILENAME, load: (directory) => new NoteStore(directory, { watch: false }).load() },
  { filename: IDENTITIES_FILENAME, load: (directory) => new NoteStore(directory, { watch: false }).load() },
  { filename: PRICES_FILENAME, load: loadPrices },
  { filename: path.join(EVENTS_DIRNAME, ROLLUP_FILENAME), load: (directory) => new ActivityLog(directory, { timeZone: 'UTC' }).rollup() },
  {
    filename: courses.TRUST_FILENAME,
    load: (directory) =>
      courses.confirmationFor(
        { root: null, dataDir: directory, configDir: directory, builtin: new Map() },
        { id: 'custom', version: '1.0.0', source: 'user', contentHash: 'confirmed-content' },
      ),
  },
];

for (const source of sources) {
  test(`${source.filename} exposes corruption without silently loading empty data`, { tags: ['integration'] }, async () => {
    const directory = await tempDir('taskpilot-corruption-');
    const file = path.join(directory, source.filename);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ broken');
    await assert.rejects(source.load(directory), { code: 'storage_corrupt' });
    assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
  });
}

test('changing the notes directory cannot erase a corrupt location sidecar', { tags: ['integration'] }, async () => {
  const directory = await tempDir('taskpilot-corruption-');
  const file = path.join(directory, LOCATION_FILENAME);
  await fs.writeFile(file, '{ broken');
  const notes = new NoteStore(directory, { watch: false });
  await assert.rejects(notes.setDirectory(null), { code: 'storage_corrupt' });
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
});

test('a corrupt private manifest prevents deletion of the lab and its reference solution', { tags: ['integration'] }, async () => {
  const directory = await tempDir('taskpilot-corruption-');
  const privateDirectory = labDir(directory, 'one');
  await fs.mkdir(privateDirectory, { recursive: true });
  const file = path.join(privateDirectory, 'hints.json');
  const reference = path.join(privateDirectory, 'reference.patch');
  await fs.writeFile(file, '{ broken', { mode: 0o600 });
  await fs.writeFile(reference, 'private original', { mode: 0o600 });
  await assert.rejects(readHints(directory, 'one'), { code: 'storage_corrupt' });
  await assert.rejects(writePrivate(directory, 'one', { reference: 'replacement', hidden: {}, hints: [], verify: null }), { code: 'storage_corrupt' });
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
  assert.equal(await fs.readFile(reference, 'utf8'), 'private original');
});

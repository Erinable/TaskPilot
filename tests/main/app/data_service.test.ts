import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { createDataService } from '../../../src/main/app/data_service.ts';
import { BackgroundRuns } from '../../../src/main/app/background_runs.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
import { NoteStore } from '../../../src/main/notes/note_store.ts';
import { RepositoryRegistry } from '../../../src/main/repository/repositories.ts';
import * as backups from '../../../src/main/infrastructure/data_backup.ts';

const setup = async () => {
  const root = await tempDir('taskpilot-data-service-');
  const configDir = path.join(root, 'config');
  const destination = path.join(root, 'exports');
  const externalNotes = path.join(root, 'vault');
  await Promise.all([fs.mkdir(configDir), fs.mkdir(destination), fs.mkdir(externalNotes)]);
  const notes = await new NoteStore(configDir, { watch: false }).load();
  onTestFinished(() => notes.close());
  const choices: (string | null)[] = [];
  const backgroundRuns = new BackgroundRuns();
  const flushStores = vi.fn<Parameters<typeof createDataService>[0]['flushStores']>(async () => {
    await notes.flush();
    return [undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  });
  const ctx = {
    configDir,
    appVersion: '0.1.0',
    notes,
    backgroundRuns,
    flushStores,
    getPreferences: preferences.defaults,
    repositories: await new RepositoryRegistry(configDir).load(),
    shell: { pickDirectory: async () => choices.shift() ?? null },
  };
  return { configDir, destination, externalNotes, notes, choices, backgroundRuns, flushStores, service: createDataService(ctx) };
};

test(
  'backup declares external notes without copying them and carries draft recovery through preview and acknowledgement',
  { tags: ['integration'] },
  async () => {
    const h = await setup();
    await fs.writeFile(path.join(h.externalNotes, 'private.md'), 'external private note');
    await h.notes.setDirectory(h.externalNotes);
    const entries = { 'taskpilot:draft:compose': '{"text":"unfinished requirement"}' };
    h.choices.push(h.destination);
    const backup = await h.service.backup(entries);
    assert.ok(backup);
    assert.equal(backup.externalNotes, h.externalNotes);
    assert.equal(backup.drafts, 1);
    assert.ok(h.flushStores.mock.calls.length > 0);
    const manifest = await backups.verifyBackup(backup.path);
    assert.ok(!manifest.files.some((file) => file.path.endsWith('private.md')));
    h.choices.push(backup.path);
    const preview = await h.service.previewRestore();
    assert.ok(preview);
    assert.equal(preview.externalNotes, h.externalNotes);
    assert.equal(preview.drafts, 1);
    const currentDrafts = { 'taskpilot:draft:compose': '{"version":1,"value":{"text":"current local draft"}}' };
    const prepared = await h.service.restore(preview.id, currentDrafts);
    await backups.applyPendingRestore(h.configDir);
    const originals = await backups.verifyBackup(prepared.rollbackPath);
    assert.equal(originals.externalNotes, h.externalNotes);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(prepared.rollbackPath, 'data', 'renderer_drafts.json'), 'utf8')), currentDrafts);
    const recovered = await h.service.restoredDrafts();
    assert.ok(recovered);
    assert.deepEqual(recovered.entries, entries);
    await assert.rejects(h.service.acknowledgeDrafts('stale-token'), { code: 'invalid_argument' });
    assert.deepEqual(await h.service.restoredDrafts(), recovered);
    assert.equal(await h.service.acknowledgeDrafts(recovered.token), true);
    assert.equal(await h.service.restoredDrafts(), null);
    assert.equal(await fs.readFile(path.join(h.externalNotes, 'private.md'), 'utf8'), 'external private note');
  },
);

test('a cancelled or superseded preview cannot authorize a later restore', { tags: ['integration'] }, async () => {
  const h = await setup();
  h.choices.push(h.destination);
  const backup = await h.service.backup({});
  assert.ok(backup);
  h.choices.push(backup.path, backup.path, null);
  const first = await h.service.previewRestore();
  const second = await h.service.previewRestore();
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
  await assert.rejects(h.service.restore(first.id), { code: 'invalid_argument' });
  assert.equal(await h.service.previewRestore(), null);
  await assert.rejects(h.service.restore(second.id), { code: 'invalid_argument' });
  await assert.rejects(fs.access(`${h.configDir}.restore-pending`), { code: 'ENOENT' });
});

test('restore revalidates files changed after preview instead of trusting the earlier hash', { tags: ['integration'] }, async () => {
  const h = await setup();
  h.choices.push(h.destination);
  const backup = await h.service.backup({});
  assert.ok(backup);
  h.choices.push(backup.path);
  const preview = await h.service.previewRestore();
  assert.ok(preview);
  await fs.writeFile(path.join(backup.path, 'data', 'renderer_drafts.json'), '{"tampered":true}');
  await assert.rejects(h.service.restore(preview.id), { code: 'invalid_argument' });
  await assert.rejects(fs.access(`${h.configDir}.restore-pending`), { code: 'ENOENT' });
});

test('restore refuses a different valid snapshot substituted after preview', { tags: ['integration'] }, async () => {
  const h = await setup();
  h.choices.push(h.destination);
  const backup = await h.service.backup({});
  assert.ok(backup);
  h.choices.push(backup.path);
  const preview = await h.service.previewRestore();
  assert.ok(preview);
  const replacement = Buffer.from(JSON.stringify({ 'taskpilot:draft:compose': '{"version":1,"value":{"text":"different snapshot"}}' }));
  const manifestFile = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as backups.BackupManifest;
  const entry = manifest.files.find((file) => file.path === 'renderer_drafts.json');
  assert.ok(entry);
  entry.size = replacement.length;
  entry.sha256 = createHash('sha256').update(replacement).digest('hex');
  await fs.writeFile(path.join(backup.path, 'data', entry.path), replacement);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await backups.verifyBackup(backup.path);
  await assert.rejects(h.service.restore(preview.id), { code: 'invalid_state' });
  await assert.rejects(fs.access(`${h.configDir}.restore-pending`), { code: 'ENOENT' });
});

test('backup refuses background activity and invalid draft data before copying a snapshot', { tags: ['integration'] }, async () => {
  const h = await setup();
  const held = h.backgroundRuns.start({ kind: 'grade', key: 'held', busy: 'grade', label: () => 'grading' });
  h.choices.push(h.destination);
  await assert.rejects(h.service.backup({}), { code: 'invalid_state' });
  assert.deepEqual(await fs.readdir(h.destination), []);
  h.backgroundRuns.finish('grade', 'held', held);
  await assert.rejects(h.service.backup({ unrelated: 'not a TaskPilot draft' }), { code: 'invalid_argument' });
  assert.deepEqual(await fs.readdir(h.destination), []);
});

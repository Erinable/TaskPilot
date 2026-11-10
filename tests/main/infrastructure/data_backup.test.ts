import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import * as backups from '../../../src/main/infrastructure/data_backup.ts';

const setup = async (files: Record<string, string> = { 'preferences.json': '{"version":1,"value":"backup"}' }) => {
  const root = await tempDir('taskpilot-backup-');
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const target = path.join(root, 'target');
  await Promise.all([fs.mkdir(source), fs.mkdir(destination), fs.mkdir(target)]);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const backup = await backups.createBackup(source, destination, {
    appVersion: '0.1.0',
    externalNotes: '/external/vault',
    drafts: { 'taskpilot:draft:compose': '{"text":"saved"}' },
  });
  return { root, source, destination, target, backup };
};

test('backup and restore roundtrip retains pre-restore data as another selectable backup', { tags: ['integration'] }, async () => {
  const { target, backup } = await setup();
  await fs.writeFile(path.join(target, 'preferences.json'), '{"version":1,"value":"original"}');
  await fs.writeFile(path.join(target, 'mastery.json'), '{"version":2,"records":[]}');
  const manifest = await backups.verifyBackup(backup.path);
  assert.equal(manifest.externalNotes, '/external/vault');
  assert.equal(backup.drafts, 1);
  assert.equal((await fs.stat(path.join(backup.path, 'data', 'preferences.json'))).mode & 0o777, 0o600);
  const prepared = await backups.prepareRestore(target, backup.path);
  assert.equal(await backups.applyPendingRestore(target), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'preferences.json'), 'utf8')).value, 'backup');
  assert.equal(JSON.parse(await fs.readFile(path.join(prepared.rollbackPath, 'data', 'preferences.json'), 'utf8')).value, 'original');
  assert.equal(await fs.readFile(path.join(prepared.rollbackPath, 'data', 'mastery.json'), 'utf8'), '{"version":2,"records":[]}');
  await backups.verifyBackup(prepared.rollbackPath);
  await assert.rejects(fs.access(path.join(target, 'mastery.json')), { code: 'ENOENT' });
  assert.equal(await backups.applyPendingRestore(target), false);
});

test('restore rejects files used as data directories and directories used as JSON files', { tags: ['integration'] }, async () => {
  const cases: Record<string, string>[] = [{ notes: 'not a directory' }, { 'preferences.json/child': '{}' }];
  for (const files of cases) {
    const { backup, target } = await setup(files);
    const original = '{"version":1,"value":"original"}';
    await fs.writeFile(path.join(target, 'preferences.json'), original);
    await assert.rejects(backups.prepareRestore(target, backup.path), { code: 'invalid_argument' });
    assert.equal(await fs.readFile(path.join(target, 'preferences.json'), 'utf8'), original);
  }
});

test('backup refuses source symlinks and locations inside the source data', { tags: ['integration'] }, async () => {
  const { root, source, destination } = await setup();
  await fs.symlink(path.join(root, 'target'), path.join(source, 'notes'), 'dir');
  await assert.rejects(backups.createBackup(source, destination, { appVersion: null, externalNotes: null }), { code: 'invalid_argument' });
  await assert.rejects(backups.createBackup(source, source, { appVersion: null, externalNotes: null }), { code: 'invalid_argument' });
});

test('verification rejects payload hashes, traversal paths and duplicate manifest entries', { tags: ['integration'] }, async () => {
  const { backup } = await setup();
  const manifestFile = path.join(backup.path, 'manifest.json');
  const original = await fs.readFile(manifestFile, 'utf8');
  const dataFile = path.join(backup.path, 'data', 'preferences.json');
  const before = await fs.readFile(dataFile, 'utf8');
  await fs.writeFile(dataFile, 'tampered');
  await assert.rejects(backups.verifyBackup(backup.path), { code: 'invalid_argument' });
  await fs.writeFile(dataFile, before);
  for (const invalidPath of ['../preferences.json', 'notes/../../preferences.json', '/preferences.json', 'notes\\escape']) {
    const manifest = JSON.parse(original) as backups.BackupManifest;
    manifest.files[0]!.path = invalidPath;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(backups.verifyBackup(backup.path), { code: 'invalid_argument' });
  }
  const duplicate = JSON.parse(original) as backups.BackupManifest;
  duplicate.files.push(duplicate.files[0]!);
  await fs.writeFile(manifestFile, JSON.stringify(duplicate));
  await assert.rejects(backups.verifyBackup(backup.path), { code: 'invalid_argument' });
});

for (const relative of [
  'repos/repo/labs/one/hints.json',
  'repos/repo/labs/one/verify.json',
  'repos/repo/labs/one/rubric.json',
  'lab_drafts/requirement/verify.json',
  'events/cost_rollup.json',
  'repos/repo/events/cost_rollup.json',
]) {
  test(`restore rejects a future application manifest at ${relative}`, { tags: ['integration'] }, async () => {
    const { backup, target } = await setup({ [relative]: '{"version":99}' });
    await assert.rejects(backups.prepareRestore(target, backup.path), { code: 'unsupported_version' });
    await assert.rejects(fs.access(`${target}.restore-pending`), { code: 'ENOENT' });
  });
}

test('restore rejects future activity storage versions without changing torn-line compatibility', { tags: ['integration'] }, async () => {
  const { backup, target } = await setup({ 'repos/repo/events/2099-01-01.jsonl': '{"storageVersion":99,"kind":"requirement_created"}\n' });
  await assert.rejects(backups.prepareRestore(target, backup.path), { code: 'unsupported_version' });
  const torn = await setup({ 'repos/repo/events/2099-01-01.jsonl': '{"storageVersion":1,"kind":"requirement_created"}\n{"torn"' });
  await backups.verifyBackup(torn.backup.path);
});

test('a future current file is retained before any root is restored', { tags: ['integration'] }, async () => {
  const { target, backup } = await setup();
  const before = '{"version":99,"future":"keep"}';
  await fs.writeFile(path.join(target, 'preferences.json'), '{"version":1,"value":"original"}');
  await backups.prepareRestore(target, backup.path);
  await fs.writeFile(path.join(target, 'mastery.json'), before);
  await assert.rejects(backups.applyPendingRestore(target), { code: 'unsupported_version' });
  assert.equal(await fs.readFile(path.join(target, 'mastery.json'), 'utf8'), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'preferences.json'), 'utf8')).value, 'original');
});

test('staging tampering is rejected before moving any current data, including an empty directory symlink', { tags: ['integration'] }, async () => {
  const { root, target, backup } = await setup({ 'preferences.json': '{"version":1,"value":"backup"}' });
  await fs.mkdir(path.join(backup.path, 'data', 'notes'));
  const manifestFile = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as backups.BackupManifest;
  manifest.roots.push('notes');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.writeFile(path.join(target, 'preferences.json'), '{"version":1,"value":"original"}');
  await backups.prepareRestore(target, backup.path);
  const stagedNotes = path.join(`${target}.restore-pending`, 'data', 'notes');
  assert.equal(path.dirname(stagedNotes), path.join(`${target}.restore-pending`, 'data'));
  await fs.rename(stagedNotes, path.join(root, 'preserved-empty-notes'));
  await fs.symlink(path.join(root, 'source'), stagedNotes, 'dir');
  await assert.rejects(backups.applyPendingRestore(target), { code: 'invalid_argument' });
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'preferences.json'), 'utf8')).value, 'original');
});

test('apply refuses a staging data-directory symlink before moving any external files', { tags: ['integration'] }, async () => {
  const { root, target, backup } = await setup();
  const original = '{"version":1,"value":"original"}';
  await fs.writeFile(path.join(target, 'preferences.json'), original);
  await backups.prepareRestore(target, backup.path);
  const payload = path.join(`${target}.restore-pending`, 'data');
  const preserved = path.join(root, 'preserved-payload');
  const external = path.join(root, 'external-payload');
  assert.equal(path.dirname(payload), `${target}.restore-pending`);
  await fs.rename(payload, preserved);
  await fs.cp(preserved, external, { recursive: true });
  await fs.symlink(external, payload, 'dir');
  await assert.rejects(backups.applyPendingRestore(target), { code: 'invalid_argument' });
  assert.equal(await fs.readFile(path.join(target, 'preferences.json'), 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(path.join(external, 'preferences.json'), 'utf8')).value, 'backup');
});

for (const linkAt of ['history', 'rollback', 'data'] as const) {
  test(`restore refuses a symlink at the ${linkAt} directory before preserving originals`, { tags: ['integration'] }, async () => {
    const { root, target, backup } = await setup();
    const before = '{"version":1,"value":"original"}';
    await fs.writeFile(path.join(target, 'preferences.json'), before);
    const prepared = await backups.prepareRestore(target, backup.path);
    const external = path.join(root, 'external-history');
    await fs.mkdir(external);
    const link =
      linkAt === 'history' ? path.dirname(prepared.rollbackPath) : linkAt === 'rollback' ? prepared.rollbackPath : path.join(prepared.rollbackPath, 'data');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(external, link, 'dir');
    await assert.rejects(backups.applyPendingRestore(target), { code: 'invalid_argument' });
    assert.equal(await fs.readFile(path.join(target, 'preferences.json'), 'utf8'), before);
    assert.deepEqual(await fs.readdir(external), []);
  });
}

for (const installed of [false, true]) {
  test(`restore resumes when stopped ${installed ? 'after installing the new root' : 'after preserving the old root'}`, { tags: ['integration'] }, async () => {
    const { target, backup } = await setup();
    const file = path.join(target, 'preferences.json');
    await fs.writeFile(file, '{"version":1,"value":"original"}');
    const prepared = await backups.prepareRestore(target, backup.path);
    const original = path.join(prepared.rollbackPath, 'data', 'preferences.json');
    await fs.mkdir(path.dirname(original), { recursive: true });
    assert.equal(path.dirname(file), target);
    await fs.rename(file, original);
    if (installed) await fs.rename(path.join(`${target}.restore-pending`, 'data', 'preferences.json'), file);
    assert.equal(await backups.applyPendingRestore(target), true);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).value, 'backup');
    assert.equal(JSON.parse(await fs.readFile(original, 'utf8')).value, 'original');
    await backups.verifyBackup(prepared.rollbackPath);
  });
}

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir as createTempDir } from '../../fixtures/temp_dir.ts';
import { BACKUP_DIRNAME, REGISTRY_FILENAME, RepositoryRegistry, UNASSIGNED_ID, repositoryId } from '../../../src/main/repository/repositories.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';

const tempDir = (prefix: string) => createTempDir(prefix);

// The files an earlier version kept directly in userData.
const seedLegacy = async (configDir: string, root: string | null) => {
  await fs.writeFile(path.join(configDir, 'workspace.json'), JSON.stringify({ version: 2, root, checks: { test: { command: 'npm', args: ['test'] } } }));
  await fs.writeFile(path.join(configDir, 'requirements.json'), JSON.stringify([{ id: 'req-1', status: 'draft' }]));
  await fs.writeFile(path.join(configDir, 'work-packages.json'), '{}');
  await fs.mkdir(path.join(configDir, 'events'));
  await fs.writeFile(path.join(configDir, 'events', '2026-10-01.jsonl'), '{}\n');
  await fs.writeFile(path.join(configDir, 'preferences.json'), '{}');
};

test('a fresh install starts with no repositories and no backup', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  assert.equal(registry.current, null);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.dataDir(), path.join(configDir, 'repos', UNASSIGNED_ID));
  await assert.rejects(fs.access(path.join(configDir, BACKUP_DIRNAME)));
});

test('legacy files move to the configured repository after a backup', async () => {
  const configDir = await tempDir('tp-repos-');
  await seedLegacy(configDir, '/work/app');
  const registry = await new RepositoryRegistry(configDir).load();

  assert.equal(registry.current?.root, '/work/app');
  assert.equal(registry.current?.id, repositoryId('/work/app'));
  const dir = registry.dataDir();
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'requirements.json'), 'utf8'))[0].id, 'req-1');
  assert.equal(await fs.readFile(path.join(dir, 'events', '2026-10-01.jsonl'), 'utf8'), '{}\n');
  assert.equal((await registry.loadConfig()).steps.test?.commands[0].command, 'npm');
  // Gone from userData, kept in the backup; preferences stay global.
  await assert.rejects(fs.access(path.join(configDir, 'requirements.json')));
  assert.ok(await fs.readFile(path.join(configDir, BACKUP_DIRNAME, 'requirements.json'), 'utf8'));
  assert.ok(await fs.readFile(path.join(configDir, BACKUP_DIRNAME, 'events', '2026-10-01.jsonl'), 'utf8'));
  assert.equal(await fs.readFile(path.join(configDir, 'preferences.json'), 'utf8'), '{}');

  // The registry is written, so a second start does not migrate again.
  const again = await new RepositoryRegistry(configDir).load();
  assert.equal(again.current?.id, registry.current?.id);
});

test('without a configured root, legacy data waits in unassigned and the first repository adopts it', async () => {
  const configDir = await tempDir('tp-repos-');
  await seedLegacy(configDir, null);
  const registry = await new RepositoryRegistry(configDir).load();
  assert.equal(registry.current, null);
  assert.ok(await fs.readFile(path.join(configDir, 'repos', UNASSIGNED_ID, 'requirements.json'), 'utf8'));

  const entry = await registry.add('/work/first');
  await registry.open(entry.id);
  assert.ok(await fs.readFile(path.join(registry.dataDir(), 'requirements.json'), 'utf8'));
  await assert.rejects(fs.access(path.join(configDir, 'repos', UNASSIGNED_ID)));
  assert.equal((await registry.loadConfig()).root, '/work/first');

  // A second repository starts empty.
  const second = await registry.add('/work/second');
  await assert.rejects(fs.access(path.join(registry.dataDir(second.id), 'requirements.json')));
});

test('an interrupted migration finishes on the next start', async () => {
  const configDir = await tempDir('tp-repos-');
  await seedLegacy(configDir, '/work/app');
  // As if the previous run copied the backup and moved one file, then died.
  const target = path.join(configDir, 'repos', repositoryId('/work/app'));
  await fs.mkdir(target, { recursive: true });
  await fs.rename(path.join(configDir, 'work-packages.json'), path.join(target, 'work-packages.json'));
  await fs.mkdir(path.join(configDir, BACKUP_DIRNAME));
  await fs.writeFile(path.join(configDir, BACKUP_DIRNAME, 'requirements.json'), 'earlier backup');

  const registry = await new RepositoryRegistry(configDir).load();
  assert.ok(await fs.readFile(path.join(target, 'requirements.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(target, 'work-packages.json'), 'utf8'), '{}');
  // The first backup is never overwritten.
  assert.equal(await fs.readFile(path.join(configDir, BACKUP_DIRNAME, 'requirements.json'), 'utf8'), 'earlier backup');
  assert.equal(registry.current?.root, '/work/app');
});

test('adding the same root twice returns the existing repository', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  const first = await registry.add('/work/app');
  assert.equal((await registry.add('/work/app/')).id, first.id);
  assert.equal(registry.list().length, 1);
});

test('a symlinked path is the same repository', async () => {
  const configDir = await tempDir('tp-repos-');
  const real = await tempDir('tp-repos-real-');
  const link = path.join(await tempDir('tp-repos-link-'), 'app');
  await fs.symlink(real, link);
  const registry = await new RepositoryRegistry(configDir).load();
  const first = await registry.add(link);
  assert.equal((await registry.add(await fs.realpath(real))).id, first.id);
  assert.equal(registry.list().length, 1);
});

test('the list is most recently opened first and survives a restart', async () => {
  const configDir = await tempDir('tp-repos-');
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const now = () => new Date((clock += 1000));
  const registry = await new RepositoryRegistry(configDir, { now }).load();
  const a = await registry.add('/work/a');
  const b = await registry.add('/work/b');
  await registry.open(b.id);
  await registry.open(a.id);
  assert.deepEqual(
    registry.list().map((entry) => entry.root),
    ['/work/a', '/work/b'],
  );
  const reloaded = await new RepositoryRegistry(configDir).load();
  assert.equal(reloaded.current?.id, a.id);
});

test('relocating keeps the id and data; the registry root wins over workspace.json', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  const entry = await registry.add('/work/old');
  await registry.open(entry.id);
  await registry.saveConfig(workspace.normalize({ root: '/elsewhere', checks: { test: { command: 'npm', args: ['test'] } } }));
  assert.equal((await registry.loadConfig()).root, '/work/old');

  await registry.relocate(entry.id, '/work/new');
  assert.equal(registry.current?.id, entry.id);
  const config = await registry.loadConfig();
  assert.equal(config.root, '/work/new');
  assert.equal(config.steps.test?.commands[0].command, 'npm');
  // A later repository at the old path gets a fresh directory, not this one.
  const reused = await registry.add('/work/old');
  assert.notEqual(reused.id, entry.id);
});

test('relocating onto another known root is refused', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  const a = await registry.add('/work/a');
  await registry.add('/work/b');
  await assert.rejects(registry.relocate(a.id, '/work/b'), { code: 'repository_exists' });
});

test('a registry entry with a bad id or relative root is dropped on load', async () => {
  const configDir = await tempDir('tp-repos-');
  const good = { id: repositoryId('/work/app'), root: '/work/app', addedAt: '', lastOpenedAt: '' };
  await fs.writeFile(
    path.join(configDir, REGISTRY_FILENAME),
    JSON.stringify({ version: 1, current: '../../etc', repositories: [good, { id: '../../etc', root: '/x' }, { id: 'a'.repeat(16), root: 'rel' }] }),
  );
  const registry = await new RepositoryRegistry(configDir).load();
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    [good.id],
  );
  assert.equal(registry.current, null);
});

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

test('legacy workspace corruption and newer versions stop migration before moving original files', async () => {
  for (const [before, code] of [
    ['{ broken', 'storage_corrupt'],
    [JSON.stringify({ version: workspace.CONFIG_VERSION + 1, root: '/keep/future' }), 'unsupported_version'],
  ] as const) {
    const configDir = await tempDir('tp-repos-');
    const file = path.join(configDir, workspace.CONFIG_FILENAME);
    await fs.writeFile(file, before);
    await fs.writeFile(path.join(configDir, 'requirements.json'), '[]');
    await assert.rejects(new RepositoryRegistry(configDir).load(), { code });
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(await fs.readFile(path.join(configDir, 'requirements.json'), 'utf8'), '[]');
    await assert.rejects(fs.access(path.join(configDir, REGISTRY_FILENAME)), { code: 'ENOENT' });
  }
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

test('removing a repository keeps its data, and adding the folder again brings it back', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  const root = await tempDir('tp-repos-root-');
  const entry = await registry.add(root);
  await registry.open(entry.id);
  await fs.writeFile(path.join(registry.dataDir(entry.id), 'requirements.json'), '[]');
  await assert.rejects(registry.remove(entry.id), { code: 'invalid_state' });

  await registry.close();
  assert.equal(registry.current, null);
  await registry.remove(entry.id);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get(entry.id), null);
  const restarted = await new RepositoryRegistry(configDir).load();
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.get(entry.id), null);
  assert.equal(restarted.current, null);
  await assert.rejects(restarted.open(entry.id), { code: 'unknown_repository' });
  await assert.rejects(registry.remove(entry.id), { code: 'unknown_repository' });

  await fs.mkdir(registry.dataDir(UNASSIGNED_ID), { recursive: true });
  const again = await restarted.add(root);
  assert.equal(again.id, entry.id);
  assert.equal(again.addedAt, entry.addedAt);
  assert.equal(await fs.readFile(path.join(restarted.dataDir(again.id), 'requirements.json'), 'utf8'), '[]');
});

for (const moved of [false, true]) {
  test(`readding through a real path alias restores all data after restart${moved ? ' and relocation' : ''}`, async () => {
    const configDir = await tempDir('tp-repos-');
    const folders = await tempDir('tp-repos-roots-');
    const original = path.join(folders, 'original');
    const alias = path.join(folders, 'alias');
    await fs.mkdir(original);
    await fs.symlink(original, alias);
    const registry = await new RepositoryRegistry(configDir).load();
    const entry = await registry.add(alias);
    await registry.open(entry.id);
    await registry.saveConfig(workspace.normalize({ checks: { test: { command: 'npm', args: ['test'] } } }));
    const data = {
      'requirements.json': '{"requirements":[{"id":"original-requirement"}]}',
      'work-packages.json': '{"packages":{"original-package":{"status":"done"}}}',
      'releases.json': '{"releases":[{"version":"1.0.0"}]}',
      'tutor.json': '{"original-package":"explanation"}',
      'course_trust.json': '{"trusted":"course-hash"}',
      'events/2026-10-01.jsonl': '{"type":"original-event"}\n',
      'labs/original-lab/reference.patch': 'original private reference',
      'labs/original-lab/hidden/test.sh': 'original private test',
    };
    for (const [name, contents] of Object.entries(data)) {
      const file = path.join(registry.dataDir(entry.id), name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
    let root = original;
    if (moved) {
      root = path.join(folders, 'moved');
      await fs.rename(original, root);
      const movedAlias = path.join(folders, 'moved-alias');
      await fs.symlink(root, movedAlias);
      await registry.relocate(entry.id, movedAlias);
      await fs.unlink(movedAlias);
    }
    await registry.close();
    await registry.remove(entry.id);
    await fs.unlink(alias);
    const restarted = await new RepositoryRegistry(configDir).load();
    assert.deepEqual(restarted.list(), []);
    const readdAlias = path.join(folders, 'readd-alias');
    await fs.symlink(root, readdAlias);
    const restored = await restarted.add(readdAlias);
    assert.equal(restored.id, entry.id);
    assert.equal(restored.addedAt, entry.addedAt);
    assert.equal(restored.lastOpenedAt, entry.lastOpenedAt);
    assert.equal(restored.root, await fs.realpath(root));
    assert.equal((await restarted.add(root)).id, entry.id);
    assert.equal(restarted.list().length, 1);
    await restarted.open(restored.id);
    const config = await restarted.loadConfig();
    assert.equal(config.root, await fs.realpath(root));
    assert.equal(config.steps.test?.commands[0].command, 'npm');
    for (const [name, contents] of Object.entries(data)) assert.equal(await fs.readFile(path.join(restarted.dataDir(), name), 'utf8'), contents);
    const reopened = await new RepositoryRegistry(configDir).load();
    assert.equal(reopened.current?.id, entry.id);
    await reopened.close();
    await reopened.remove(entry.id);
    assert.equal((await new RepositoryRegistry(configDir).load().then((saved) => saved.add(root))).id, entry.id);
  });
}

for (const removed of [false, true]) {
  test(`a new repository at a relocated repository's old root cannot take its ${removed ? 'removed' : 'active'} identity`, async () => {
    const configDir = await tempDir('tp-repos-');
    const folders = await tempDir('tp-repos-roots-');
    const original = path.join(folders, 'original');
    const moved = path.join(folders, 'moved');
    await fs.mkdir(original);
    const registry = await new RepositoryRegistry(configDir).load();
    const entry = await registry.add(original);
    await fs.writeFile(path.join(registry.dataDir(entry.id), 'requirements.json'), 'original requirements');
    await fs.rename(original, moved);
    await registry.relocate(entry.id, moved);
    if (removed) await registry.remove(entry.id);
    await fs.mkdir(original);
    const restarted = await new RepositoryRegistry(configDir).load();
    const replacement = await restarted.add(original);
    assert.notEqual(replacement.id, entry.id);
    await assert.rejects(fs.access(path.join(restarted.dataDir(replacement.id), 'requirements.json')), { code: 'ENOENT' });
    await fs.writeFile(path.join(restarted.dataDir(replacement.id), 'requirements.json'), 'replacement requirements');
    const reloaded = await new RepositoryRegistry(configDir).load();
    const restored = await reloaded.add(moved);
    assert.equal(restored.id, entry.id);
    assert.equal(await fs.readFile(path.join(reloaded.dataDir(restored.id), 'requirements.json'), 'utf8'), 'original requirements');
    assert.equal(await fs.readFile(path.join(reloaded.dataDir(replacement.id), 'requirements.json'), 'utf8'), 'replacement requirements');
  });
}

for (const missingData of [false, true]) {
  test(`restoring a removed identity does not adopt unassigned data${missingData ? ' when its data directory is missing' : ''}`, async () => {
    const configDir = await tempDir('tp-repos-');
    const root = await tempDir('tp-repos-root-');
    const registry = await new RepositoryRegistry(configDir).load();
    const entry = await registry.add(root);
    await registry.remove(entry.id);
    if (missingData) await fs.rename(registry.dataDir(entry.id), path.join(configDir, 'saved-data'));
    const unassigned = registry.dataDir(UNASSIGNED_ID);
    await fs.mkdir(unassigned, { recursive: true });
    await fs.writeFile(path.join(unassigned, 'requirements.json'), 'unassigned requirements');
    const restarted = await new RepositoryRegistry(configDir).load();
    const restored = await restarted.add(root);
    assert.equal(restored.id, entry.id);
    await assert.rejects(fs.access(path.join(restarted.dataDir(restored.id), 'requirements.json')), { code: 'ENOENT' });
    const otherRoot = await tempDir('tp-repos-other-');
    await restarted.remove(restored.id);
    const other = await restarted.add(otherRoot);
    await assert.rejects(fs.access(path.join(restarted.dataDir(other.id), 'requirements.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(unassigned, 'requirements.json'), 'utf8'), 'unassigned requirements');
  });
}

test('a removed identity stays reserved even when its data directory is missing', async () => {
  const configDir = await tempDir('tp-repos-');
  const folders = await tempDir('tp-repos-roots-');
  const original = path.join(folders, 'original');
  const moved = path.join(folders, 'moved');
  await fs.mkdir(original);
  const registry = await new RepositoryRegistry(configDir).load();
  const entry = await registry.add(original);
  await fs.rename(original, moved);
  await registry.relocate(entry.id, moved);
  await registry.remove(entry.id);
  await fs.rename(registry.dataDir(entry.id), path.join(configDir, 'saved-data'));
  await fs.mkdir(original);
  const restarted = await new RepositoryRegistry(configDir).load();
  const replacement = await restarted.add(original);
  assert.notEqual(replacement.id, entry.id);
  const restored = await restarted.add(moved);
  assert.equal(restored.id, entry.id);
  assert.notEqual(restarted.dataDir(replacement.id), restarted.dataDir(restored.id));
});

test('relocating onto a removed root is refused, including through a symlink', async () => {
  const configDir = await tempDir('tp-repos-');
  const root = await tempDir('tp-repos-root-');
  const alias = path.join(await tempDir('tp-repos-alias-'), 'alias');
  await fs.symlink(root, alias);
  const registry = await new RepositoryRegistry(configDir).load();
  const removed = await registry.add(root);
  await registry.remove(removed.id);
  const other = await registry.add(await tempDir('tp-repos-other-'));
  await assert.rejects(registry.relocate(other.id, alias), { code: 'repository_exists', field: 'root' });
  assert.equal((await registry.add(alias)).id, removed.id);
});

test('legacy registries without removed entries remain readable with or without version 1', async () => {
  for (const version of [undefined, 1]) {
    const configDir = await tempDir('tp-repos-');
    const root = await tempDir('tp-repos-root-');
    const entry = { id: repositoryId(root), root, addedAt: '2026-10-01T00:00:00Z', lastOpenedAt: '2026-10-02T00:00:00Z' };
    await fs.writeFile(path.join(configDir, REGISTRY_FILENAME), JSON.stringify({ version, current: entry.id, repositories: [entry] }));
    const registry = await new RepositoryRegistry(configDir).load();
    assert.deepEqual(registry.current, entry);
    await registry.close();
    await registry.remove(entry.id);
    const restarted = await new RepositoryRegistry(configDir).load();
    assert.equal((await restarted.add(root)).id, entry.id);
  }
});

test('future registry versions are refused on load and before replacing a loaded registry', async () => {
  const configDir = await tempDir('tp-repos-');
  const registry = await new RepositoryRegistry(configDir).load();
  const entry = await registry.add(await tempDir('tp-repos-root-'));
  const file = path.join(configDir, REGISTRY_FILENAME);
  const before = JSON.stringify({ version: 2, current: entry.id, repositories: [entry], future: 'keep this data' });
  await fs.writeFile(file, before);
  await assert.rejects(new RepositoryRegistry(configDir).load(), { code: 'unsupported_version' });
  await assert.rejects(registry.remove(entry.id), { code: 'unsupported_version' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

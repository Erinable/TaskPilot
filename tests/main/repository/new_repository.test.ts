/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { gitRepo } from '../../fixtures/git_repo.ts';
import * as git from '../../../src/main/repository/git.ts';
import { createRepository } from '../../../src/main/repository/new_repository.ts';

test('an empty folder becomes a repository with one commit and a clean tree', async () => {
  const root = await fs.realpath(await tempDir('tp-new-repo-'));
  await createRepository(root);
  assert.equal(await git.isRepo(root), true);
  assert.match(await git.head(root), /^[0-9a-f]{40}$/);
  assert.deepEqual(await git.status(root), []);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), `# ${path.basename(root)}\n`);
});

test('a folder with files, inside a repository or missing is refused untouched', async () => {
  const full = await tempDir('tp-new-repo-');
  await fs.writeFile(path.join(full, 'notes.txt'), 'keep');
  await assert.rejects(createRepository(full), { code: 'root_not_empty' });
  assert.deepEqual(await fs.readdir(full), ['notes.txt']);

  const repo = await gitRepo({ 'a.txt': 'a' });
  const inside = path.join(repo.root, 'empty');
  await fs.mkdir(inside);
  await assert.rejects(createRepository(inside), { code: 'root_in_repository' });
  assert.deepEqual(await fs.readdir(inside), []);

  await assert.rejects(createRepository(path.join(full, 'nope')), { code: 'root_not_found' });
  await assert.rejects(createRepository('relative/dir'), { code: 'root_not_absolute' });
});

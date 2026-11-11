/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withDependencyScope } from '../../../src/main/work_packages/dependency_scope.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';

const task = { ...SAMPLE_TASKS[0], fileScope: ['package.json', 'src/news.ts'] };

test('manifest packages include existing npm lockfiles without mutating their published definition', async () => {
  const root = await tempDir('taskpilot-dependency-scope-');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
  const effective = withDependencyScope(task, root);
  assert.deepEqual(effective.fileScope, ['package.json', 'src/news.ts', 'package-lock.json']);
  assert.deepEqual(task.fileScope, ['package.json', 'src/news.ts']);
  assert.deepEqual(withDependencyScope(effective, root).fileScope, effective.fileScope);
  await fs.writeFile(path.join(root, 'npm-shrinkwrap.json'), '{}\n');
  assert.deepEqual(withDependencyScope(task, root).fileScope, ['package.json', 'src/news.ts', 'npm-shrinkwrap.json', 'package-lock.json']);
});

test('companion scope does not invent a lockfile or extend unrelated and nested manifest packages', async () => {
  const root = await tempDir('taskpilot-dependency-boundary-');
  assert.equal(withDependencyScope(task, root), task);
  assert.equal(withDependencyScope(task, null), task);
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
  for (const fileScope of [['src/news.ts'], ['packages/app/package.json'], []]) {
    const other = { ...task, fileScope };
    assert.equal(withDependencyScope(other, root), other);
  }
});

test('a symlink or directory masquerading as a lockfile never widens the scope', async () => {
  const root = await tempDir('taskpilot-dependency-symlink-');
  await fs.writeFile(path.join(root, 'outside.json'), '{}\n');
  await fs.symlink('outside.json', path.join(root, 'package-lock.json'));
  await fs.mkdir(path.join(root, 'npm-shrinkwrap.json'));
  assert.equal(withDependencyScope(task, root), task);
});

/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { needsNode, runtimeTools, selectedExecutable } from '../../../src/main/runtimes/runtime_locations.ts';

test('Node dependency detection reads only shebangs and distinguishes PATH interpreters from absolute interpreters', async () => {
  const directory = await tempDir('taskpilot-runtime-shebang-');
  const cases: [string, boolean][] = [
    ['#!/usr/bin/env node\n', true],
    ['#!/usr/bin/env -S node --no-warnings\n', true],
    ['#!/opt/custom-node/bin/node\n', false],
    ['#!/bin/sh\nnode script.js\n', false],
    ['native binary entry without a shebang', false],
  ];
  for (const [header, expected] of cases) {
    const file = path.join(directory, 'entry');
    await fs.writeFile(file, `${header}throw new Error("must not execute discovery");\n`);
    assert.equal(await needsNode(file), expected, header);
  }
});

test('runtime inventory follows standard symlinks in paths containing spaces and reports a missing external Node independently of embedded Node', async () => {
  const root = await tempDir('taskpilot-runtime-inventory-');
  const bin = path.join(root, 'Other User', 'CLI tools');
  const packageDirectory = path.join(root, 'Package Contents');
  const nodeBin = path.join(root, 'Node Runtime', 'bin');
  await Promise.all([fs.mkdir(bin, { recursive: true }), fs.mkdir(packageDirectory), fs.mkdir(nodeBin, { recursive: true })]);
  const target = path.join(packageDirectory, 'cli.js');
  await fs.writeFile(target, '#!/usr/bin/env node\nthrow new Error("inventory must not execute this file");\n', { mode: 0o755 });
  const cli = path.join(bin, 'claude');
  await fs.symlink(target, cli);
  const missingNode = await runtimeTools(bin);
  const detected = missingNode.find((tool) => tool.id === 'claude');
  assert.equal(detected?.path, cli);
  assert.equal(detected?.realPath, await fs.realpath(target));
  assert.equal(detected?.requiresNode, true);
  assert.match(detected?.problem ?? '', /应用内置的 Node\.js 不能代替/);
  assert.equal(missingNode.find((tool) => tool.id === 'node')?.path, null);
  await fs.symlink(process.execPath, path.join(nodeBin, 'node'));
  const complete = await runtimeTools([bin, nodeBin].join(path.delimiter));
  assert.equal(complete.find((tool) => tool.id === 'claude')?.problem, null);
  assert.equal(complete.find((tool) => tool.id === 'node')?.realPath, await fs.realpath(process.execPath));
});

test('selectedExecutable preserves the standard command name symlink instead of returning its renamed target directory', async () => {
  const root = await tempDir('taskpilot-runtime-picker-');
  const bin = path.join(root, 'chosen tools');
  const targetDirectory = path.join(root, 'different package');
  await Promise.all([fs.mkdir(bin), fs.mkdir(targetDirectory)]);
  const target = path.join(targetDirectory, 'cli.js');
  await fs.writeFile(target, '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const selected = path.join(bin, 'claude');
  await fs.symlink(target, selected);
  assert.deepEqual(await selectedExecutable('claude', selected), { path: selected, directory: bin });
  await assert.rejects(selectedExecutable('claude', target), { code: 'invalid_argument' });
});

test('selectedExecutable rejects nonexistent, nonexecutable, directory and parameter-bearing selections', async () => {
  const root = await tempDir('taskpilot-runtime-invalid-');
  const cli = path.join(root, 'claude');
  await assert.rejects(selectedExecutable('claude', cli), { code: 'invalid_argument' });
  await fs.mkdir(cli);
  await assert.rejects(selectedExecutable('claude', cli), { code: 'invalid_argument' });
  await fs.rmdir(cli);
  await fs.writeFile(cli, '#!/bin/sh\n', { mode: 0o600 });
  await assert.rejects(selectedExecutable('claude', cli), { code: 'invalid_argument' });
  await assert.rejects(selectedExecutable('claude', `${cli} --version`), { code: 'invalid_argument' });
  await assert.rejects(selectedExecutable('claude', 'claude'), { code: 'invalid_argument' });
});

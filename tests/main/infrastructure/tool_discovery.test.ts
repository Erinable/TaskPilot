/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { tempDir } from '../../fixtures/temp_dir.ts';
import * as discovery from '../../../src/main/infrastructure/tool_discovery.ts';
import { createPathResolver } from '../../../src/main/infrastructure/shell_env.ts';

const execute = promisify(execFile);
const tool = async (file: string, body = '#!/bin/sh\nexit 0\n') => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { mode: 0o755 });
  return path.dirname(file);
};
const homeFixture = async () => {
  const home = await tempDir('taskpilot-tool-home-');
  return { home, platform: 'darwin' as const, systemPaths: [], toolHomes: {} };
};

test('Finder minimal PATH discovers an npm CLI and its Node runtime without launching a shell', async () => {
  const options = await homeFixture();
  const nodeBin = path.join(options.home, '.nvm', 'versions', 'node', 'v24.12.0', 'bin');
  await fs.mkdir(nodeBin, { recursive: true });
  await fs.symlink(process.execPath, path.join(nodeBin, 'node'));
  await tool(path.join(nodeBin, 'claude'), '#!/usr/bin/env node\nconsole.log("discovered-cli:" + process.versions.node);\n');
  const resolver = createPathResolver({
    ...options,
    inherited: '/usr/bin:/bin:/usr/sbin:/sbin',
    read: () => assert.fail('automatic discovery must not execute the shell'),
  });
  const resolved = await resolver.resolve('auto');
  assert.equal(resolved.source, 'auto');
  assert.equal(resolved.error, null);
  assert.ok(resolved.path.split(':').includes(nodeBin));
  const result = await execute('claude', [], { env: { PATH: resolved.path } });
  assert.equal(result.stdout.trim(), `discovered-cli:${process.versions.node}`);
});

test('conventional directories need an executable and exclude irrelevant caches', async () => {
  const options = await homeFixture();
  await fs.mkdir(path.join(options.home, '.npm', 'bin'), { recursive: true });
  const local = await tool(path.join(options.home, '.local', 'bin', 'claude'));
  const cargo = await tool(path.join(options.home, '.cargo', 'bin', 'cargo'));
  await fs.mkdir(path.join(options.home, '.opencode', 'bin'), { recursive: true });
  await fs.writeFile(path.join(options.home, '.opencode', 'bin', 'opencode'), 'not executable', { mode: 0o600 });
  await tool(path.join(options.home, '.cache', 'node', 'bin', 'node'));
  assert.deepEqual(await discovery.discoverToolPaths(options), [local, cargo]);
});

test('nvm follows bounded nested default aliases and orders the preferred runtime first', async () => {
  const options = await homeFixture();
  const root = path.join(options.home, '.nvm');
  const preferred = await tool(path.join(root, 'versions', 'node', 'v22.10.0', 'bin', 'node'));
  const newest = await tool(path.join(root, 'versions', 'node', 'v24.12.0', 'bin', 'node'));
  await tool(path.join(newest, 'codex'));
  await fs.mkdir(path.join(root, 'alias', 'lts'), { recursive: true });
  await fs.writeFile(path.join(root, 'alias', 'default'), 'work\n');
  await fs.writeFile(path.join(root, 'alias', 'work'), 'lts/*\n');
  await fs.writeFile(path.join(root, 'alias', 'lts', '*'), 'v22\n');
  assert.deepEqual(await discovery.discoverToolPaths(options), [preferred, newest]);
});

test('cyclic or unsafe nvm aliases never add arbitrary paths', async () => {
  const options = await homeFixture();
  const root = path.join(options.home, '.nvm');
  const nodeBin = await tool(path.join(root, 'versions', 'node', 'v24.0.0', 'bin', 'node'));
  await fs.mkdir(path.join(root, 'alias'), { recursive: true });
  await fs.writeFile(path.join(root, 'alias', 'default'), 'loop');
  await fs.writeFile(path.join(root, 'alias', 'loop'), 'default');
  assert.deepEqual(await discovery.discoverToolPaths(options), [nodeBin]);
  await fs.writeFile(path.join(root, 'alias', 'default'), '../../workspace/bin');
  assert.deepEqual(await discovery.discoverToolPaths(options), [nodeBin]);
});

test('manager version discovery selects a runtime and CLI bins without scanning cache or node_modules', async () => {
  const options = await homeFixture();
  const fnm = await tool(path.join(options.home, '.local', 'share', 'fnm', 'node-versions', 'v24.1.0', 'installation', 'bin', 'node'));
  const mise = await tool(path.join(options.home, '.local', 'share', 'mise', 'installs', 'node', '22.1.0', 'bin', 'node'));
  const asdf = await tool(path.join(options.home, '.asdf', 'installs', 'nodejs', '20.1.0', 'bin', 'node'));
  await tool(path.join(options.home, '.local', 'share', 'fnm', 'node-versions', 'cache', 'installation', 'bin', 'node'));
  await tool(path.join(options.home, '.asdf', 'installs', 'nodejs', 'node_modules', 'bin', 'node'));
  assert.deepEqual(await discovery.discoverToolPaths(options), [fnm, mise, asdf]);
});

test('manager overrides and standard system locations are injected independently of the host', async () => {
  const options = await homeFixture();
  const alternate = path.join(options.home, 'managed');
  const nvm = await tool(path.join(alternate, 'nvm', 'versions', 'node', 'v24.0.0', 'bin', 'node'));
  const npm = await tool(path.join(alternate, 'npm', 'bin', 'codex'));
  const homebrew = await tool(path.join(options.home, 'homebrew', 'bin', 'git'));
  const result = await discovery.discoverToolPaths({
    ...options,
    systemPaths: [homebrew],
    toolHomes: { nvm: path.join(alternate, 'nvm'), npmPrefix: path.join(alternate, 'npm') },
  });
  assert.deepEqual(result, [homebrew, npm, nvm]);
  assert.deepEqual(await discovery.discoverToolPaths({ ...options, platform: 'win32' }), []);
});

test('a conventional executable symlink adds its Node bin without adding HOME or package internals', async () => {
  const options = await homeFixture();
  const nativeBin = await tool(path.join(options.home, 'managed-runtime', 'bin', 'node'));
  const cli = path.join(nativeBin, 'claude');
  await tool(cli);
  const local = path.join(options.home, '.local', 'bin');
  await fs.mkdir(local, { recursive: true });
  await fs.symlink(cli, path.join(local, 'claude'));
  const result = await discovery.discoverToolPaths(options);
  assert.deepEqual(result, [local, nativeBin]);
  assert.ok(!result.includes(options.home));
  assert.ok(!result.some((directory) => directory.includes('node_modules')));
});

test('real Node installations precede manager shims when an isolated HOME is used', async () => {
  for (const manager of ['volta', 'asdf', 'mise'] as const) {
    const options = await homeFixture();
    const root = manager === 'mise' ? path.join(options.home, '.local', 'share', 'mise') : path.join(options.home, `.${manager}`);
    const versions = manager === 'volta' ? ['tools', 'image', 'node'] : ['installs', manager === 'asdf' ? 'nodejs' : 'node'];
    const nodeBin = path.join(root, ...versions, '24.12.0', 'bin');
    const shimBin = path.join(root, manager === 'volta' ? 'bin' : 'shims');
    await fs.mkdir(nodeBin, { recursive: true });
    await fs.symlink(process.execPath, path.join(nodeBin, 'node'));
    await tool(path.join(shimBin, 'node'), '#!/bin/sh\necho "manager HOME was used" >&2\nexit 44\n');
    await tool(path.join(shimBin, 'claude'), '#!/usr/bin/env node\nconsole.log("isolated-cli:" + process.env.HOME);\n');
    const scratch = path.join(options.home, 'scratch');
    await fs.mkdir(scratch);
    const resolver = createPathResolver({ ...options, inherited: '/usr/bin:/bin', read: () => assert.fail('auto must not run shell') });
    const resolved = await resolver.resolve('auto');
    assert.ok(resolved.path.indexOf(nodeBin) < resolved.path.indexOf(shimBin));
    const result = await execute('claude', [], { env: { PATH: resolved.path, HOME: scratch } });
    assert.equal(result.stdout.trim(), `isolated-cli:${scratch}`);
  }
});

test('manager version symlinks into package internals are not added to PATH', async () => {
  const options = await homeFixture();
  const cache = await tool(path.join(options.home, 'node_modules', 'untrusted', 'bin', 'node'));
  const versions = path.join(options.home, '.nvm', 'versions', 'node');
  await fs.mkdir(versions, { recursive: true });
  await fs.symlink(path.dirname(cache), path.join(versions, 'v24.0.0'), 'dir');
  assert.deepEqual(await discovery.discoverToolPaths(options), []);
});

test('the installation search is bounded despite many runtime versions', async () => {
  const options = await homeFixture();
  for (let version = 1; version <= discovery.MAX_MANAGER_ENTRIES + 2; version += 1) {
    const bin = await tool(path.join(options.home, '.nvm', 'versions', 'node', `v${version}.0.0`, 'bin', 'node'));
    await tool(path.join(bin, 'claude'));
  }
  const result = await discovery.discoverToolPaths(options);
  assert.equal(result.length, 4);
  assert.ok(result.every((directory) => /^v\d+\.0\.0$/.test(path.basename(path.dirname(directory)))));
});

test('automatic PATH omits empty and relative entries instead of searching the current workspace', async () => {
  const options = await homeFixture();
  const resolver = createPathResolver({ ...options, inherited: ':/usr/bin:.:relative/bin', read: () => assert.fail('must not read shell') });
  const result = await resolver.resolve('auto', ['', '.', 'relative/node_modules/.bin', '/manual/tools']);
  assert.equal(result.path, '/manual/tools:/usr/bin');
  assert.ok(!result.path.split(':').includes(process.cwd()));
});

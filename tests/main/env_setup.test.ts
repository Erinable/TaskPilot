import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as envSetup from '../../src/main/env_setup.ts';

const run = promisify(execFile);

const repo = async (files: Record<string, string>, { untracked = {} as Record<string, string> } = {}) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-env-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const g = (args) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  for (const [file, content] of Object.entries(untracked)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
};

const fakeVersions =
  (node: string | null = 'v22.1.0', npm: string | null = '10.7.0') =>
  async (command) =>
    command === 'node' ? node : npm;

test('probe reads tracked manifests, pins, lockfiles and workflows', async () => {
  const root = await repo(
    {
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test', 'lint:js': 'eslint .' }, engines: { node: '>=20' } }),
      'package-lock.json': '{}',
      '.nvmrc': '20\n',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm ci\n',
      '.env': 'SECRET=1\n',
    },
    { untracked: { 'node_modules/x/index.js': '' } },
  );
  const facts = await envSetup.probe(root, { version: fakeVersions() });
  assert.ok(facts.manifest);
  assert.equal(facts.manifest.name, 'demo');
  assert.deepEqual(Object.keys(facts.manifest.scripts), ['test', 'lint:js']);
  assert.deepEqual(facts.manifest.engines, { node: '>=20' });
  assert.deepEqual(facts.lockfiles, ['package-lock.json']);
  assert.deepEqual(facts.managers, ['npm']);
  assert.equal(facts.nodeModules, true);
  assert.deepEqual(facts.versionFiles, [{ path: '.nvmrc', content: '20' }]);
  assert.deepEqual(
    facts.workflows.map((w) => w.path),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(facts.tools, { node: 'v22.1.0', npm: '10.7.0' });
  assert.deepEqual(envSetup.blockers(facts), []);
});

test('probe ignores untracked manifests and reports blockers', async () => {
  const root = await repo({ 'README.md': 'hi\n', 'yarn.lock': '' }, { untracked: { 'package.json': '{}' } });
  const facts = await envSetup.probe(root, { version: fakeVersions(null, null) });
  assert.equal(facts.manifest, null);
  assert.equal(facts.nodeModules, false);
  assert.deepEqual(envSetup.blockers(facts), ['no_manifest', 'unsupported_manager', 'node_missing', 'npm_missing']);
});

test('parseManifest drops odd script names and survives bad JSON', () => {
  assert.equal(envSetup.parseManifest('{nope').valid, false);
  const manifest = envSetup.parseManifest(JSON.stringify({ scripts: { test: 'x', '; rm -rf /': 'y', '-x': 'z', build: 3 } }));
  assert.deepEqual(manifest.scripts, { test: 'x' });
});

test('install commands disable lifecycle scripts unless allowed', () => {
  assert.deepEqual(envSetup.installCommand('ci'), { command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] });
  assert.deepEqual(envSetup.installCommand('install', { allowScripts: true }).args, ['install', '--no-audit', '--no-fund']);
  assert.throws(() => envSetup.installCommand('exec'), { code: 'invalid_mode' });
});

test('buildSteps only runs scripts the manifest defines', () => {
  const facts: any = { manifest: { scripts: { test: 'node --test', 'lint:js': 'eslint .' } } };
  const steps = envSetup.buildSteps({ install: 'ci', scripts: { test: 'test', lint: 'lint:js', build: null } }, facts);
  assert.deepEqual(
    steps.map((s) => [s.id, s.command, ...s.args]),
    [
      ['install', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['test', 'npm', 'test'],
      ['lint', 'npm', 'run', 'lint:js'],
    ],
  );
  assert.throws(() => envSetup.buildSteps({ install: 'skip', scripts: { test: 'nope' } }, facts), { code: 'invalid_script' });
});

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo' },
    'node_modules/electron': { version: '40.0.0', dev: true, hasInstallScript: true },
    'node_modules/@scope/native': { version: '1.0.0', hasInstallScript: true },
    'node_modules/vite/node_modules/esbuild': { version: '0.25.0', hasInstallScript: true },
    // Platform-only and optional: skipping its script is expected.
    'node_modules/fsevents': { version: '2.3.3', optional: true, hasInstallScript: true },
    'node_modules/plain': { version: '1.0.0' },
    // Never passed to npm: not a package name.
    'node_modules/--force': { hasInstallScript: true },
  },
});

test('the lockfile names the packages that need install scripts, without optional ones', async () => {
  assert.deepEqual(envSetup.parseInstallScripts(LOCK), ['@scope/native', 'electron', 'esbuild']);
  assert.deepEqual(envSetup.parseInstallScripts('{broken'), []);
  const root = await repo({ 'package.json': JSON.stringify({ name: 'demo' }), 'package-lock.json': LOCK });
  assert.deepEqual((await envSetup.probe(root, { version: fakeVersions() })).installScripts, ['@scope/native', 'electron', 'esbuild']);
});

test('a scripts-off install is followed by a rebuild of only those packages', () => {
  const facts: any = { manifest: { scripts: {} }, installScripts: ['electron', 'esbuild'] };
  const plan = { install: 'ci' as const, scripts: {} };
  assert.deepEqual(
    envSetup.buildSteps(plan, facts).map((s) => [s.id, s.command, ...s.args]),
    [
      ['install', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['rebuild', 'npm', 'rebuild', 'electron', 'esbuild'],
    ],
  );
  // With scripts allowed, install runs them all; no rebuild step.
  assert.deepEqual(
    envSetup.buildSteps(plan, facts, { allowScripts: true }).map((s) => s.id),
    ['install'],
  );
  // No install, nothing to rebuild.
  assert.deepEqual(envSetup.buildSteps({ install: 'skip', scripts: {} }, facts), []);
  assert.throws(() => envSetup.rebuildCommand(['--global']), { code: 'invalid_package' });
  assert.throws(() => envSetup.rebuildCommand([]), { code: 'invalid_package' });
});

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

/** @module-tag integration */
// Each preset's committed version, read through `git show` from a real
// repository: the working tree never counts.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { typescriptPreset } from '../../../../src/main/checking/presets/typescript.ts';
import { rustPreset } from '../../../../src/main/checking/presets/rust.ts';
import { pythonPreset } from '../../../../src/main/checking/presets/python.ts';
import { versionReaderOf } from '../../../../src/main/checking/presets/index.ts';
import type { Preset } from '../../../../src/main/checking/presets/preset.ts';
import { tempDir } from '../../../fixtures/temp_dir.ts';
const run = promisify(execFile);

// A repository whose only commit holds `files`; returns a reader of that commit.
const committed = async (files: Record<string, string>) => {
  const dir = await tempDir('taskpilot-version-');
  const g = async (args: string[]) => (await run('git', args, { cwd: dir })).stdout.trim();
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 'test@example.com']);
  await g(['config', 'user.name', 'Test']);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  await fs.writeFile(path.join(dir, 'README.md'), 'demo\n');
  await g(['add', '.']);
  await g(['commit', '-qm', 'init']);
  const head = await g(['rev-parse', 'HEAD']);
  return { dir, head, read: (preset: Pick<Preset, 'version'>) => preset.version(dir, head) };
};

test('TypeScript reads package.json', async () => {
  const repo = await committed({ 'package.json': JSON.stringify({ name: 'demo', version: ' 1.2.3-beta.1 ' }) });
  assert.deepEqual(await repo.read(typescriptPreset), { file: 'package.json', value: '1.2.3-beta.1' });
  // The working tree is not what gets released.
  await fs.writeFile(path.join(repo.dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal((await repo.read(typescriptPreset)).value, '1.2.3-beta.1');
});

test('Rust reads [package].version, then [workspace.package].version', async () => {
  const crate = await committed({ 'Cargo.toml': '[package]\nname = "demo"\nversion = "0.4.0"\n' });
  assert.deepEqual(await crate.read(rustPreset), { file: 'Cargo.toml', value: '0.4.0' });
  const virtual = await committed({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "2.0.1"\n' });
  assert.equal((await virtual.read(rustPreset)).value, '2.0.1');
  // A root package inheriting the workspace version.
  const inherited = await committed({
    'Cargo.toml': '[package]\nname = "demo"\nversion.workspace = true\n\n[workspace.package]\nversion = "3.1.0"\n',
  });
  assert.equal((await inherited.read(rustPreset)).value, '3.1.0');
});

test('Python reads [project].version, then [tool.poetry].version', async () => {
  const pep621 = await committed({ 'pyproject.toml': '[project]\nname = "demo"\nversion = "1.0.0"\n' });
  assert.deepEqual(await pep621.read(pythonPreset), { file: 'pyproject.toml', value: '1.0.0' });
  const poetry = await committed({ 'pyproject.toml': '[tool.poetry]\nname = "demo"\nversion = "0.2.5"\n' });
  assert.equal((await poetry.read(pythonPreset)).value, '0.2.5');
});

test('a missing, unparsable or non-semver manifest has no version', async () => {
  const empty = await committed({});
  for (const preset of [typescriptPreset, rustPreset, pythonPreset]) assert.equal((await empty.read(preset)).value, null);
  const broken = await committed({ 'package.json': '{ not json', 'Cargo.toml': '[package\nversion = "1.0.0"', 'pyproject.toml': 'version = = 1' });
  for (const preset of [typescriptPreset, rustPreset, pythonPreset]) assert.equal((await broken.read(preset)).value, null);
  const loose = await committed({
    'package.json': JSON.stringify({ version: 'latest' }),
    'Cargo.toml': '[package]\nname = "demo"\nversion = "1.0"\n',
    // PEP 440, not semver; and a dynamic version is only known after a build.
    'pyproject.toml': '[project]\nname = "demo"\nversion = "1.0.0.post1"\n',
  });
  for (const preset of [typescriptPreset, rustPreset, pythonPreset]) assert.equal((await loose.read(preset)).value, null);
  const dynamic = await committed({ 'pyproject.toml': '[project]\nname = "demo"\ndynamic = ["version"]\n' });
  assert.equal((await dynamic.read(pythonPreset)).value, null);
});

test('without a preset the version comes from package.json', async () => {
  const repo = await committed({ 'package.json': JSON.stringify({ version: '1.0.0' }), 'Cargo.toml': '[package]\nversion = "5.0.0"\n' });
  assert.deepEqual(await versionReaderOf([])(repo.dir, repo.head), { file: 'package.json', value: '1.0.0' });
  assert.deepEqual(await versionReaderOf(['unknown'])(repo.dir, repo.head), { file: 'package.json', value: '1.0.0' });
  assert.deepEqual(await versionReaderOf(['rust'])(repo.dir, repo.head), { file: 'Cargo.toml', value: '5.0.0' });
});

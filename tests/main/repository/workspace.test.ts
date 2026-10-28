import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir as createTempDir } from '../../fixtures/temp_dir.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';

const tempDir = () => createTempDir('taskpilot-ws-');

test('save() then load() round-trips a v3 config', async () => {
  const dir = await tempDir();
  const saved = await workspace.save(dir, {
    version: 3,
    root: '/tmp/project',
    steps: { lint: { commands: [{ command: 'npm', args: ['run', 'lint'] }], parser: { format: 'json', dialect: 'eslint' } }, coverage: { enabled: false } },
  });
  assert.deepEqual(saved.steps.lint?.commands, [{ command: 'npm', args: ['run', 'lint'] }]);
  assert.deepEqual(saved.steps.lint?.parser, { format: 'json', dialect: 'eslint', path: null });
  assert.equal(saved.steps.coverage?.enabled, false);
  assert.deepEqual(await workspace.load(dir), saved);
  const raw = JSON.parse(await fs.readFile(path.join(dir, workspace.CONFIG_FILENAME), 'utf8'));
  assert.equal(raw.version, 3);
  assert.ok(!('checks' in raw));
});

test('normalize() drops unknown keys and blank roots', () => {
  const config = workspace.normalize({ version: 3, root: '   ', evil: true, steps: {} });
  assert.deepEqual(config, workspace.emptyConfig());
  assert.ok(!('evil' in config));
});

test('normalize() upgrades v1 commands with the v2 defaults', () => {
  const config = workspace.normalize({ root: '/r', commands: { test: { command: 'npm', args: ['test'] }, lint: { command: 'npm', args: ['run', 'lint'] } } });
  assert.equal(config.version, 3);
  assert.deepEqual(config.steps.test, {
    enabled: true,
    commands: [{ command: 'npm', args: ['test'] }],
    cwd: '',
    stage: 'submit',
    blocking: true,
    parser: { format: 'tests' },
    env: {},
  });
  assert.equal(config.steps.lint?.stage, 'step');
  assert.equal(config.steps.lint?.blocking, false);
});

test('normalize() upgrades v2 checks: JUnit reports, env, timeouts, and smoke as custom:smoke', () => {
  const config = workspace.normalize({
    version: 2,
    root: '/r',
    checks: {
      test: {
        command: 'npx',
        args: ['vitest'],
        stage: 'submit',
        blocking: false,
        report: { format: 'junit', path: 'out/unit.xml' },
        env: { CI: '1' },
        timeoutMs: 60000,
      },
      smoke: { command: 'npm', args: ['run', 'smoke'] },
      build: null,
    },
  });
  assert.deepEqual(config.steps.test?.parser, { format: 'junit', path: 'out/unit.xml' });
  assert.equal(config.steps.test?.blocking, false);
  assert.deepEqual(config.steps.test?.env, { CI: '1' });
  assert.equal(config.steps.test?.timeoutMs, 60000);
  // v2 ran smoke before review and let it reject; it keeps doing so.
  assert.deepEqual([config.steps['custom:smoke']?.stage, config.steps['custom:smoke']?.blocking], ['submit', true]);
  assert.ok(!('build' in config.steps));
});

test('normalize() names the field of every step error', () => {
  const bad = (steps: unknown, field: string) => assert.throws(() => workspace.normalize({ version: 3, steps }), { field }, field);
  bad({ deploy: { commands: ['x'] } }, 'steps.deploy');
  bad({ lint: { commands: [] } }, 'steps.lint.commands');
  bad({ lint: { commands: ['eslint . | cat'] } }, 'steps.lint.commands[0]');
  bad({ lint: { commands: ['eslint'], stage: 'deploy' } }, 'steps.lint.stage');
  bad({ lint: { commands: ['eslint'], blocking: 'yes' } }, 'steps.lint.blocking');
  bad({ lint: { commands: ['eslint'], cwd: '../outside' } }, 'steps.lint.cwd');
  bad({ lint: { commands: ['eslint'], parser: { format: 'html' } } }, 'steps.lint.parser.format');
  bad({ test: { commands: ['x'], parser: { format: 'junit', path: '/tmp/out.xml' } } }, 'steps.test.parser.path');
  bad({ lint: { commands: ['x'], parser: { format: 'regex', pattern: '(' } } }, 'steps.lint.parser.pattern');
  bad({ lint: { commands: ['x'], env: { PATH: '/evil' } } }, 'steps.lint.env.PATH');
  bad({ lint: { commands: ['x'], env: { NODE_OPTIONS: '--require x' } } }, 'steps.lint.env.NODE_OPTIONS');
  bad({ lint: { commands: ['x'], timeoutMs: 10 } }, 'steps.lint.timeoutMs');
});

test('load() returns an empty config when the file is absent', async () => {
  const config = await workspace.load(await tempDir());
  assert.deepEqual(config, workspace.emptyConfig());
});

test('load() reports invalid JSON instead of throwing a SyntaxError', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, workspace.CONFIG_FILENAME), '{ not json');
  await assert.rejects(() => workspace.load(dir), { code: 'invalid_json' });
});

test('isInside() accepts paths within the root', () => {
  assert.ok(workspace.isInside('/repo', 'src/main.js'));
  assert.ok(workspace.isInside('/repo', './src/main.js'));
});

test('isInside() rejects escapes, the root itself, and absolute outsiders', () => {
  assert.ok(!workspace.isInside('/repo', '../secrets'));
  assert.ok(!workspace.isInside('/repo', 'src/../../secrets'));
  assert.ok(!workspace.isInside('/repo', '/etc/passwd'));
  assert.ok(!workspace.isInside('/repo', '.'));
});

test('resolveExecutable() finds a bare name through PATH', async () => {
  const dir = await tempDir();
  const bin = path.join(dir, 'tp-tool');
  await fs.writeFile(bin, '#!/bin/sh\n');
  await fs.chmod(bin, 0o755);
  assert.equal(await workspace.resolveExecutable('tp-tool', { envPath: dir, platform: 'linux' }), bin);
  assert.equal(await workspace.resolveExecutable('tp-missing', { envPath: dir, platform: 'linux' }), null);
});

test('resolveExecutable() resolves a relative path against the workspace', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'bin'));
  const bin = path.join(dir, 'bin', 'check');
  await fs.writeFile(bin, '#!/bin/sh\n');
  await fs.chmod(bin, 0o755);
  assert.equal(await workspace.resolveExecutable('./bin/check', { cwd: dir, envPath: '', platform: 'linux' }), bin);
});

test('resolveExecutable() skips files that are not executable', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'not-exec');
  await fs.writeFile(file, 'data\n');
  await fs.chmod(file, 0o644);
  assert.equal(await workspace.resolveExecutable('not-exec', { envPath: dir, platform: 'linux' }), null);
});

test('course overrides the repository pack on this machine and round-trips', async () => {
  const dir = await tempDir();
  assert.equal(workspace.normalize({ version: 3, steps: {} }).course, null);
  const saved = await workspace.save(dir, { version: 3, root: '/tmp/project', steps: {}, course: 'os' });
  assert.equal(saved.course, 'os');
  assert.equal((await workspace.load(dir)).course, 'os');
  assert.throws(() => workspace.normalize({ version: 3, steps: {}, course: 'Not An Id' }), { code: 'invalid_course', field: 'course' });
});

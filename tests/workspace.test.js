const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const workspace = require('../src/workspace');

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ws-'));
  test.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('load() returns an empty config when the file is absent', async () => {
  const config = await workspace.load(await tempDir());
  assert.deepEqual(config, workspace.emptyConfig());
});

test('save() then load() round-trips the config', async () => {
  const dir = await tempDir();
  const saved = await workspace.save(dir, {
    root: '/tmp/project',
    commands: { test: { command: 'npm', args: ['test'] } },
  });
  assert.deepEqual(saved.commands.test, { command: 'npm', args: ['test'] });
  assert.deepEqual(await workspace.load(dir), saved);
});

test('load() reports invalid JSON instead of throwing a SyntaxError', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, workspace.CONFIG_FILENAME), '{ not json');
  await assert.rejects(() => workspace.load(dir), { code: 'invalid_json' });
});

test('normalize() drops unknown keys and blank roots', () => {
  const config = workspace.normalize({ root: '   ', evil: true, commands: { nope: {} } });
  assert.deepEqual(config, workspace.emptyConfig());
  assert.ok(!('evil' in config));
  assert.ok(!('nope' in config.commands));
});

test('a command must carry an executable name', () => {
  assert.throws(() => workspace.normalizeCommand({ args: ['test'] }, 'test'), { code: 'invalid_command' });
  assert.throws(() => workspace.normalizeCommand({ command: '  ' }, 'test'), { code: 'invalid_command' });
  assert.throws(() => workspace.normalizeCommand('npm test', 'test'), { code: 'invalid_command' });
});

test('command args must be an array of strings', () => {
  assert.throws(() => workspace.normalizeCommand({ command: 'npm', args: 'test' }, 'test'), { code: 'invalid_command' });
  assert.throws(() => workspace.normalizeCommand({ command: 'npm', args: [1] }, 'test'), { code: 'invalid_command' });
});

test('a command keeps shell metacharacters as literal argv entries', () => {
  // Nothing is parsed as an operator because execution never uses a shell.
  const command = workspace.normalizeCommand({ command: 'npm', args: ['test', '&& rm -rf /'] }, 'test');
  assert.deepEqual(command.args, ['test', '&& rm -rf /']);
});

test('normalizeCommand() copies args so callers cannot mutate the config', () => {
  const args = ['test'];
  const command = workspace.normalizeCommand({ command: 'npm', args }, 'test');
  args.push('--watch');
  assert.deepEqual(command.args, ['test']);
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

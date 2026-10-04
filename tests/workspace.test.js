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

test('parseCommandLine() splits on whitespace', () => {
  assert.deepEqual(workspace.parseCommandLine('  npm   run  lint ', 'lint'), { command: 'npm', args: ['run', 'lint'] });
});

test('parseCommandLine() treats a blank line as not configured', () => {
  assert.equal(workspace.parseCommandLine('', 'test'), null);
  assert.equal(workspace.parseCommandLine('   ', 'test'), null);
  assert.equal(workspace.parseCommandLine(undefined, 'test'), null);
});

test('parseCommandLine() groups quoted words and honours escapes', () => {
  assert.deepEqual(
    workspace.parseCommandLine(`node --test "tests/a b.test.js" 'it''s' x\\ y ""`, 'test').args,
    ['--test', 'tests/a b.test.js', 'its', 'x y', ''],
  );
  assert.deepEqual(workspace.parseCommandLine('echo "say \\"hi\\""', 'test').args, ['say "hi"']);
});

test('parseCommandLine() leaves $VARS and globs literal', () => {
  // No expansion happens: these reach the program exactly as typed.
  assert.deepEqual(workspace.parseCommandLine('jest $HOME *.ts ~', 'test').args, ['$HOME', '*.ts', '~']);
});

test('parseCommandLine() rejects unquoted shell operators', () => {
  for (const line of ['npm test && npm run lint', 'npm test | tee log', 'npm test > out.txt', 'a ; b']) {
    assert.throws(() => workspace.parseCommandLine(line, 'test'), { code: 'shell_syntax', field: 'test' }, line);
  }
});

test('parseCommandLine() accepts a quoted operator as a literal argument', () => {
  assert.deepEqual(workspace.parseCommandLine("grep '|' file", 'lint').args, ['|', 'file']);
});

test('parseCommandLine() reports an unterminated quote', () => {
  assert.throws(() => workspace.parseCommandLine('npm "test', 'test'), { code: 'unterminated_quote', field: 'test' });
});

test('formatCommandLine() round-trips through parseCommandLine()', () => {
  const entries = [
    { command: 'npm', args: ['test'] },
    { command: '/opt/my tools/run', args: ["it's", 'a b', '', '&&', 'back\\slash'] },
  ];
  for (const entry of entries) {
    assert.deepEqual(workspace.parseCommandLine(workspace.formatCommandLine(entry), 'test'), entry);
  }
  assert.equal(workspace.formatCommandLine(null), '');
});

test('fromForm() converts command lines and tags errors with their field', () => {
  const config = workspace.fromForm({ root: ' /repo ', commands: { test: 'npm test', lint: '', build: undefined } });
  assert.deepEqual(config, { root: '/repo', commands: { test: { command: 'npm', args: ['test'] }, lint: null, build: null } });
  assert.throws(() => workspace.fromForm({ commands: { build: 'make && make install' } }), { field: 'build' });
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

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as commandLine from '../../../src/main/checking/command_line.ts';

test('a command must carry an executable name', () => {
  assert.throws(() => commandLine.normalizeCommand({ args: ['test'] }, 'test'), { code: 'invalid_command' });
  assert.throws(() => commandLine.normalizeCommand({ command: '  ' }, 'test'), { code: 'invalid_command' });
  assert.throws(() => commandLine.normalizeCommand('npm test', 'test'), { code: 'invalid_command' });
});

test('command args must be an array of strings', () => {
  assert.throws(() => commandLine.normalizeCommand({ command: 'npm', args: 'test' }, 'test'), { code: 'invalid_command' });
  assert.throws(() => commandLine.normalizeCommand({ command: 'npm', args: [1] }, 'test'), { code: 'invalid_command' });
});

test('a command keeps shell metacharacters as literal argv entries', () => {
  // Nothing is parsed as an operator because execution never uses a shell.
  const command = commandLine.normalizeCommand({ command: 'npm', args: ['test', '&& rm -rf /'] }, 'test');
  assert.deepEqual(command!.args, ['test', '&& rm -rf /']);
});

test('normalizeCommand() copies args so callers cannot mutate the config', () => {
  const args = ['test'];
  const command = commandLine.normalizeCommand({ command: 'npm', args }, 'test');
  args.push('--watch');
  assert.deepEqual(command!.args, ['test']);
});

test('parseCommandLine() splits on whitespace', () => {
  assert.deepEqual(commandLine.parseCommandLine('  npm   run  lint ', 'lint'), { command: 'npm', args: ['run', 'lint'] });
});

test('parseCommandLine() treats a blank line as not configured', () => {
  assert.equal(commandLine.parseCommandLine('', 'test'), null);
  assert.equal(commandLine.parseCommandLine('   ', 'test'), null);
  assert.equal(commandLine.parseCommandLine(undefined, 'test'), null);
});

test('parseCommandLine() groups quoted words and honours escapes', () => {
  assert.deepEqual(commandLine.parseCommandLine(`node --test "tests/a b.test.js" 'it''s' x\\ y ""`, 'test')!.args, [
    '--test',
    'tests/a b.test.js',
    'its',
    'x y',
    '',
  ]);
  assert.deepEqual(commandLine.parseCommandLine('echo "say \\"hi\\""', 'test')!.args, ['say "hi"']);
});

test('parseCommandLine() leaves $VARS and globs literal', () => {
  // No expansion happens: these reach the program exactly as typed.
  assert.deepEqual(commandLine.parseCommandLine('jest $HOME *.ts ~', 'test')!.args, ['$HOME', '*.ts', '~']);
});

test('parseCommandLine() rejects unquoted shell operators', () => {
  for (const line of ['npm test && npm run lint', 'npm test | tee log', 'npm test > out.txt', 'a ; b']) {
    assert.throws(() => commandLine.parseCommandLine(line, 'test'), { code: 'shell_syntax', field: 'test' }, line);
  }
});

test('parseCommandLine() accepts a quoted operator as a literal argument', () => {
  assert.deepEqual(commandLine.parseCommandLine("grep '|' file", 'lint')!.args, ['|', 'file']);
});

test('parseCommandLine() reports an unterminated quote', () => {
  assert.throws(() => commandLine.parseCommandLine('npm "test', 'test'), { code: 'unterminated_quote', field: 'test' });
});

test('formatCommandLine() round-trips through parseCommandLine()', () => {
  const entries = [
    { command: 'npm', args: ['test'] },
    { command: '/opt/my tools/run', args: ["it's", 'a b', '', '&&', 'back\\slash'] },
  ];
  for (const entry of entries) {
    assert.deepEqual(commandLine.parseCommandLine(commandLine.formatCommandLine(entry), 'test'), entry);
  }
  assert.equal(commandLine.formatCommandLine(null), '');
});

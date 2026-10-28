/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tempDir } from '../../fixtures/temp_dir.ts';
import * as shellEnv from '../../../src/main/infrastructure/shell_env.ts';

const { MARKER } = shellEnv;

test('extractPath() reads the fenced value and ignores rc-file noise', () => {
  const output = `Welcome back!\nnvm: using node 24\n${MARKER}/opt/homebrew/bin:/usr/bin${MARKER}\nbye`;
  assert.equal(shellEnv.extractPath(output), '/opt/homebrew/bin:/usr/bin');
});

test('extractPath() returns null without a complete fence or with an empty value', () => {
  assert.equal(shellEnv.extractPath('no marker here'), null);
  assert.equal(shellEnv.extractPath(`${MARKER}/usr/bin`), null);
  assert.equal(shellEnv.extractPath(`${MARKER}${MARKER}`), null);
});

test('shellCommand() uses a fixed script and a list join for fish', () => {
  const zsh = shellEnv.shellCommand('/bin/zsh');
  assert.equal(zsh.file, '/bin/zsh');
  assert.deepEqual(zsh.args.slice(0, 1), ['-ilc']);
  assert.match(zsh.args[1], /"\$PATH"/);
  assert.match(shellEnv.shellCommand('/opt/homebrew/bin/fish').args[1], /string join : \$PATH/);
});

test('shellCommand() refuses shells it does not know how to drive', () => {
  assert.throws(() => shellEnv.shellCommand('/usr/bin/python3'), { code: 'unsupported_shell' });
});

test('readLoginShellPath() reads PATH from a real shell', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir('taskpilot-shell-');
  // HOME points at an empty dir so the user's real rc files don't run.
  const run = (file, args, options, callback) =>
    execFile(file, args, { ...options, env: { ...options.env, HOME: dir, PATH: '/usr/bin:/bin:/tp-marker' } }, callback);
  const value = await shellEnv.readLoginShellPath({ shell: '/bin/sh', run });
  assert.ok(value.includes('/tp-marker'), value);
});

test('readLoginShellPath() trusts the marker even when the shell exits non-zero', async () => {
  const run = (_file, _args, _options, callback) => callback(Object.assign(new Error('exit 1'), { code: 1 }), `${MARKER}/usr/bin${MARKER}`);
  assert.equal(await shellEnv.readLoginShellPath({ shell: '/bin/zsh', run }), '/usr/bin');
});

test('readLoginShellPath() distinguishes a timeout from missing output', async () => {
  const timeout = (_f, _a, _o, callback) => callback(Object.assign(new Error('killed'), { killed: true }), '');
  await assert.rejects(() => shellEnv.readLoginShellPath({ shell: '/bin/zsh', run: timeout }), { code: 'shell_timeout' });
  const silent = (_f, _a, _o, callback) => callback(null, 'hello');
  await assert.rejects(() => shellEnv.readLoginShellPath({ shell: '/bin/zsh', run: silent }), { code: 'shell_no_path' });
});

test('readLoginShellPath() requires an absolute SHELL', async () => {
  await assert.rejects(() => shellEnv.readLoginShellPath({ shell: '' }), { code: 'no_shell' });
  await assert.rejects(() => shellEnv.readLoginShellPath({ shell: 'zsh' }), { code: 'no_shell' });
});

test('the resolver passes the inherited PATH through for "inherit"', async () => {
  const resolver = shellEnv.createPathResolver({ inherited: '/usr/bin', read: () => assert.fail('should not run') });
  assert.deepEqual(await resolver.resolve('inherit'), { source: 'inherit', path: '/usr/bin', error: null });
});

test('the resolver caches the login-shell PATH until refreshed', async () => {
  let calls = 0;
  const resolver = shellEnv.createPathResolver({ inherited: '/usr/bin', read: async () => `/shell/${++calls}` });
  const [a, b] = await Promise.all([resolver.resolve('login-shell'), resolver.resolve('login-shell')]);
  assert.equal(a.path, '/shell/1');
  assert.equal(b.path, '/shell/1');
  assert.equal(calls, 1, 'concurrent calls share one shell launch');
  resolver.refresh();
  assert.equal((await resolver.resolve('login-shell')).path, '/shell/2');
});

test('the resolver falls back to the inherited PATH when the shell fails', async () => {
  const resolver = shellEnv.createPathResolver({
    inherited: '/usr/bin',
    read: async () => {
      throw new shellEnv.ShellEnvError('nope', 'shell_timeout');
    },
  });
  const result = await resolver.resolve('login-shell');
  assert.equal(result.source, 'inherit');
  assert.equal(result.path, '/usr/bin');
  assert.equal(result.error!.code, 'shell_timeout');
});

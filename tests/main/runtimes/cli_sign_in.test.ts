import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { checkSignIn } from '../../../src/main/runtimes/cli_sign_in.ts';
import type { StatusRunner } from '../../../src/main/runtimes/cli_sign_in.ts';

const home = async (files: Record<string, unknown> = {}) => {
  const dir = await tempDir('taskpilot-signin-');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
};
// A status command answering `stdout` with `code`, recording what ran.
const runner = (code: number, stdout: string) => {
  const ran: string[] = [];
  const run: StatusRunner = async (command, args) => {
    ran.push([command, ...args].join(' '));
    return { code, stdout };
  };
  return { run, ran };
};
const missing: StatusRunner = async () => null;

test('a key in the environment counts, without running the CLI', async () => {
  const { run, ran } = runner(1, '');
  assert.deepEqual(await checkSignIn('claude', { home: await home(), env: { ANTHROPIC_AUTH_TOKEN: 'x' }, run }), {
    state: 'signed_in',
    source: 'env:ANTHROPIC_AUTH_TOKEN',
  });
  assert.deepEqual(ran, []);
  // Blank values do not count.
  assert.equal((await checkSignIn('grok', { home: await home(), env: { XAI_API_KEY: '  ' }, run })).state, 'unknown');
});

test('Claude: a key or helper in settings.json counts, as proxy and API-key users sign in', async () => {
  const { run } = runner(0, JSON.stringify({ loggedIn: false }));
  const proxy = await home({ '.claude/settings.json': { env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy' } } });
  assert.deepEqual(await checkSignIn('claude', { home: proxy, env: {}, run }), { state: 'signed_in', source: 'settings:ANTHROPIC_AUTH_TOKEN' });
  const helper = await home({ '.claude/settings.json': { apiKeyHelper: '/usr/local/bin/key' } });
  assert.equal((await checkSignIn('claude', { home: helper, env: {}, run })).source, 'settings:apiKeyHelper');
});

test('Claude: otherwise its own status decides, and unreadable output is unknown', async () => {
  assert.equal((await checkSignIn('claude', { home: await home(), env: {}, run: runner(0, JSON.stringify({ loggedIn: true })).run })).state, 'signed_in');
  assert.equal((await checkSignIn('claude', { home: await home(), env: {}, run: runner(1, JSON.stringify({ loggedIn: false })).run })).state, 'signed_out');
  assert.equal((await checkSignIn('claude', { home: await home(), env: {}, run: runner(0, 'not json').run })).state, 'unknown');
  assert.equal((await checkSignIn('claude', { home: await home(), env: {}, run: missing })).state, 'unknown');
});

test('a non-empty credential file counts; an empty, broken or linked one does not', async () => {
  const { run } = runner(1, 'Not logged in');
  assert.equal(
    (await checkSignIn('codex', { home: await home({ '.codex/auth.json': { OPENAI_API_KEY: 'k' } }), env: {}, run })).source,
    'file:.codex/auth.json',
  );
  for (const content of [{}, 'broken', '[1]']) {
    assert.equal(
      (await checkSignIn('codex', { home: await home({ '.codex/auth.json': content }), env: {}, run })).state,
      'signed_out',
      JSON.stringify(content),
    );
  }
  const linked = await home({ elsewhere: { token: 'x' } });
  fs.mkdirSync(path.join(linked, '.codex'));
  fs.symlinkSync(path.join(linked, 'elsewhere'), path.join(linked, '.codex', 'auth.json'));
  assert.equal((await checkSignIn('codex', { home: linked, env: {}, run })).state, 'signed_out');
});

test('Codex and OpenCode status commands decide when nothing else is found', async () => {
  assert.equal((await checkSignIn('codex', { home: await home(), env: {}, run: runner(0, 'Logged in using ChatGPT').run })).state, 'signed_in');
  assert.equal((await checkSignIn('codex', { home: await home(), env: {}, run: runner(1, 'Not logged in').run })).state, 'signed_out');
  const listed = (count: number) => `┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  ${count} credentials\n`;
  assert.equal((await checkSignIn('opencode', { home: await home(), env: {}, run: runner(0, listed(7)).run })).state, 'signed_in');
  assert.equal((await checkSignIn('opencode', { home: await home(), env: {}, run: runner(0, listed(0)).run })).state, 'signed_out');
  assert.equal((await checkSignIn('opencode', { home: await home(), env: {}, run: runner(0, '?').run })).state, 'unknown');
});

test('Pi and Grok without a credential file are unknown, never signed out', async () => {
  const { run, ran } = runner(1, '');
  assert.equal((await checkSignIn('pi', { home: await home(), env: {}, run })).state, 'unknown');
  assert.equal((await checkSignIn('grok', { home: await home(), env: {}, run })).state, 'unknown');
  assert.deepEqual(ran, []);
  assert.equal((await checkSignIn('pi', { home: await home({ '.pi/agent/auth.json': { anthropic: {} } }), env: {}, run })).state, 'signed_in');
});

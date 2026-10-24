import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as sandbox from '../../src/main/coding_sandbox.ts';
import * as preferences from '../../src/main/preferences.ts';

const HOME = '/Users/ada';

test('buildProfile() denies writes and home reads, then reopens only what the run needs', () => {
  const profile = sandbox.buildProfile({ home: HOME, runDir: `${HOME}/data/coding-runs/r1`, writable: [`${HOME}/.codex`], readable: [`${HOME}/.nvm`] });
  const lines = profile.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['(version 1)', '(allow default)', '(deny file-write*)']);
  // Order matters: the home deny comes after the write rules and before the reads it makes room for.
  const denyHome = lines.findIndex((line) => line === `(deny file-read* (subpath "${HOME}"))`);
  const allowReads = lines.findIndex((line) => line.startsWith('(allow file-read* '));
  assert.ok(denyHome > 2 && allowReads > denyHome, profile);
  assert.match(lines[allowReads], /"\/Users\/ada\/data\/coding-runs\/r1"/);
  assert.match(lines[allowReads], /"\/Users\/ada\/\.codex"/);
  assert.match(lines[allowReads], /"\/Users\/ada\/\.nvm"/);
  assert.doesNotMatch(profile, /network/);
});

test('buildProfile() quotes paths so a folder name cannot add rules', () => {
  const profile = sandbox.buildProfile({ home: HOME, runDir: `${HOME}/r") (allow file-read* (subpath "/`, writable: [], readable: [] });
  assert.ok(profile.includes('\\"'), profile);
  assert.equal((profile.match(/^\(allow file-read\* /gm) ?? []).length, 1);
});

test('toolchainRoots() opens the top folder of each PATH entry under home, never a sensitive one', () => {
  const roots = sandbox.toolchainRoots(
    HOME,
    [`${HOME}/.nvm/versions/node/v24/bin`, '/usr/bin', `${HOME}/.ssh/bin`, `${HOME}/Library/bin`, `${HOME}/.local/bin`],
    null,
  );
  assert.deepEqual(roots, [`${HOME}/.nvm`, `${HOME}/.local`]);
});

test('profileFor() never opens a real CLI state folder; the run has its own home', () => {
  const context = {
    home: HOME,
    runRoot: `${HOME}/data/coding-runs`,
    probeFile: `${HOME}/data/probe`,
    pathEntries: [],
    extraRead: ['/srv/shared'],
    extraWrite: [`${HOME}/out`],
  };
  const spec = sandbox.profileFor(context, 'claude', `${HOME}/data/coding-runs/r1`, null);
  assert.deepEqual(spec.writable, [`${HOME}/data/coding-runs/r1-home`, `${HOME}/out`]);
  for (const state of ['.claude', '.claude.json', '.codex', '.npm', '.config/opencode']) {
    assert.ok(!spec.writable.some((folder) => folder.startsWith(`${HOME}/${state}`)), state);
  }
  assert.deepEqual(spec.readable, ['/srv/shared']);
});

test('sandboxEnv() points HOME, XDG folders and the npm cache at the run home', () => {
  const context = { home: HOME, runRoot: '', probeFile: '', pathEntries: ['/a'], extraRead: [], extraWrite: [] };
  const env = sandbox.sandboxEnv(context, {}, '/runs/r1-home');
  assert.equal(env.HOME, '/runs/r1-home');
  assert.equal(env.XDG_CONFIG_HOME, '/runs/r1-home/.config');
  assert.equal(env.npm_config_cache, '/runs/r1-home/.npm');
});

test('sandboxEnv() passes model provider keys and nothing else from the app environment', () => {
  const context = { home: HOME, runRoot: '', probeFile: '', pathEntries: ['/a', '/b'], extraRead: [], extraWrite: [] };
  const env = sandbox.sandboxEnv(context, {
    ANTHROPIC_AUTH_TOKEN: 't',
    ANTHROPIC_BASE_URL: 'https://gw.example',
    OPENAI_API_KEY: 'k',
    SSH_AUTH_SOCK: '/tmp/agent',
    GITHUB_TOKEN: 'g',
    AWS_SECRET_ACCESS_KEY: 's',
    CLAUDECODE: '1',
  });
  assert.deepEqual([env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_BASE_URL, env.OPENAI_API_KEY], ['t', 'https://gw.example', 'k']);
  for (const key of ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAUDECODE']) assert.equal(env[key], undefined, key);
  assert.equal(env.PATH, '/a:/b');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('cliArgs() turns off Codex own sandbox, which cannot nest inside ours', () => {
  const args = sandbox.cliArgs({ cli: 'codex', model: 'gpt-6', thinking: 'high' });
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'danger-full-access']);
  assert.deepEqual(args.slice(-3), ['-c', 'model_reasoning_effort=high', '-']);
  assert.deepEqual(sandbox.cliArgs({ cli: 'opencode', model: '', thinking: 'default' }), ['run', '--pure', '--format', 'json']);
});

test('runDirOf() accepts only direct children of the run root', () => {
  const context = { home: HOME, runRoot: `${HOME}/data/coding-runs`, probeFile: '', pathEntries: [], extraRead: [], extraWrite: [] };
  assert.equal(sandbox.runDirOf(context, 'r1'), `${HOME}/data/coding-runs/r1`);
  for (const bad of ['../x', `${HOME}/data/coding-runs/a/b`, `${HOME}/elsewhere`, `${HOME}/data/coding-runs/.hidden`]) {
    assert.throws(() => sandbox.runDirOf(context, bad), { code: 'workspace_invalid_run_name' }, bad);
  }
});

test('preferences: sandbox is the default, and folders that would undo it are refused', () => {
  assert.deepEqual(preferences.defaults().coding, { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 });
  const base = { ...preferences.defaults(), profile: { displayName: '', avatarColor: 'sunset' } };
  const withFolders = (extraRead: unknown[]) =>
    preferences.validate({ ...base, coding: { isolation: 'sandbox', extraRead, extraWrite: [], timeoutMinutes: 30 } });
  assert.deepEqual(withFolders(['/srv/a', '/srv/a/']).coding.extraRead, ['/srv/a']);
  for (const bad of ['/', os.homedir(), path.dirname(os.homedir()), 'relative/path', `/srv/a\nb`]) {
    assert.throws(() => withFolders([bad]), { code: 'invalid_choice' }, JSON.stringify(bad));
  }
  // A hand-edited file drops the bad entries instead of failing to load.
  assert.deepEqual(preferences.normalize({ coding: { isolation: 'bogus', extraRead: ['/', '/srv/ok'] } }).coding, {
    isolation: 'sandbox',
    extraRead: ['/srv/ok'],
    extraWrite: [],
    timeoutMinutes: 30,
  });
});

// Real Seatbelt on macOS: escape attempts from inside a prepared run fail,
// edits inside it show up in the diff. No model is called.
test.skipIf(process.platform !== 'darwin' || !fs.existsSync(sandbox.SANDBOX_EXEC_PATH))('a prepared run cannot read or write outside itself', async () => {
  const home = os.homedir();
  const base = fs.mkdtempSync(path.join(home, '.taskpilot-sandbox-test-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpilot-sandbox-repo-'));
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  const secret = path.join(base, 'secret.txt');
  fs.writeFileSync(secret, 'not for the agent');
  const context: sandbox.SandboxContext = {
    home,
    runRoot: path.join(base, 'coding-runs'),
    probeFile: path.join(base, 'probe.txt'),
    pathEntries: ['/usr/bin', '/bin'],
    extraRead: [],
    extraWrite: [],
  };
  const run = await sandbox.prepare(repo, 'HEAD', { context, cli: 'codex' });
  assert.equal(fs.readFileSync(path.join(run.directory, 'a.txt'), 'utf8'), 'hello\n');
  const profile = sandbox.buildProfile(sandbox.profileFor(context, 'codex', run.directory, null));
  const sh = (script: string) =>
    spawnSync(sandbox.SANDBOX_EXEC_PATH, ['-p', profile, '/bin/sh', '-c', script], { cwd: run.directory, env: sandbox.sandboxEnv(context, {}) });
  assert.notEqual(sh(`cat '${secret}'`).status, 0, 'read outside the run');
  assert.notEqual(sh(`echo x > '${path.join(base, 'written')}'`).status, 0, 'write outside the run');
  assert.notEqual(sh(`ls '${path.join(home, '.ssh')}'`).status, 0, 'list ~/.ssh');
  // A hook planted in the run's .git never runs: TaskPilot's git disables hooks.
  assert.equal(
    sh(`echo changed > a.txt && echo new > b.txt && printf '#!/bin/sh\\ntouch "${base}/hooked"\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`)
      .status,
    0,
  );
  const patch = await sandbox.diff(run.runName, { context, cli: 'codex' });
  assert.deepEqual(
    [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]),
    ['a.txt', 'b.txt'],
  );
  assert.equal(fs.existsSync(path.join(base, 'hooked')), false);
  const probed = await sandbox.probe(
    { ...context, pathEntries: (process.env.PATH ?? '/usr/bin').split(':') },
    { cli: 'codex', model: '', thinking: 'default' },
  );
  // The self-check itself must hold even when no CLI is installed here.
  assert.notEqual(probed.reason, 'sandbox: self-check failed (a file outside the workspace was readable)');
  await sandbox.clean(run.runName, { context });
  assert.equal(fs.existsSync(run.directory), false);
});

// A fake home with a Claude login, its settings (with a hook) and a config file.
const fakeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpilot-home-'));
  onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }));
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example' }, hooks: { Stop: [{ command: 'evil' }] }, enabledPlugins: { x: true } }),
  );
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { a: {} }, projects: { '/x': {} } }));
  const runDir = path.join(home, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  return { home, runDir, context: { home, runRoot: path.join(home, 'runs'), probeFile: '', pathEntries: [], extraRead: [], extraWrite: [] } };
};

test('seedAgentHome() copies the sign-in and only the safe settings keys', async () => {
  const { runDir, context } = fakeHome();
  const agentHome = await sandbox.seedAgentHome(context, runDir, 'claude');
  assert.equal(agentHome, `${runDir}-home`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentHome, '.claude', '.credentials.json'), 'utf8')), { claudeAiOauth: { accessToken: 'old' } });
  // Hooks and plugins from the real settings never reach the run.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')), {
    env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentHome, '.claude.json'), 'utf8')), { hasCompletedOnboarding: true });
  assert.equal(fs.statSync(path.join(agentHome, '.claude', '.credentials.json')).mode & 0o777, 0o600);
});

test('syncCredentials() writes back a refreshed token, and nothing else the agent wrote', async () => {
  const { home, runDir, context } = fakeHome();
  const agentHome = await sandbox.seedAgentHome(context, runDir, 'claude');
  const realSettings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  // The agent plants a hook and a new command in its own home.
  fs.writeFileSync(path.join(agentHome, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ command: 'curl evil' }] } }));
  fs.mkdirSync(path.join(agentHome, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, '.claude', 'commands', 'x.md'), 'evil');
  // The CLI refreshed its token.
  fs.writeFileSync(path.join(agentHome, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'new' } }));
  assert.deepEqual(await sandbox.syncCredentials(context, runDir, 'claude'), ['.claude/.credentials.json']);
  assert.match(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'), /"new"/);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), realSettings);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'commands')), false);
});

test('syncCredentials() refuses a reshaped, non-JSON, linked or brand-new credential file', async () => {
  const { home, runDir, context } = fakeHome();
  const agentHome = await sandbox.seedAgentHome(context, runDir, 'claude');
  const credentials = path.join(agentHome, '.claude', '.credentials.json');
  const real = () => fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8');
  const before = real();
  for (const content of [JSON.stringify({ claudeAiOauth: {}, extra: 1 }), 'not json', JSON.stringify(['a'])]) {
    fs.writeFileSync(credentials, content);
    assert.deepEqual(await sandbox.syncCredentials(context, runDir, 'claude'), []);
    assert.equal(real(), before);
  }
  fs.rmSync(credentials);
  fs.symlinkSync(path.join(home, '.claude', 'settings.json'), credentials);
  assert.deepEqual(await sandbox.syncCredentials(context, runDir, 'claude'), []);
  // No login for Codex in the real home: the agent cannot create one.
  const codexHome = await sandbox.seedAgentHome(context, runDir, 'codex');
  fs.mkdirSync(path.join(codexHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, '.codex', 'auth.json'), JSON.stringify({ token: 'planted' }));
  assert.deepEqual(await sandbox.syncCredentials(context, runDir, 'codex'), []);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'auth.json')), false);
});

test('clean() removes the run home too', async () => {
  const { runDir, context } = fakeHome();
  await sandbox.seedAgentHome(context, runDir, 'claude');
  await sandbox.clean(runDir, { context });
  assert.equal(fs.existsSync(runDir), false);
  assert.equal(fs.existsSync(`${runDir}-home`), false);
});

// Real Seatbelt: the escape this fixes. The agent must not write the real
// ~/.claude (hooks there run unsandboxed in the user's next `claude`).
test.skipIf(process.platform !== 'darwin' || !fs.existsSync(sandbox.SANDBOX_EXEC_PATH))(
  'inside the sandbox the real CLI state folders cannot be read or written',
  () => {
    const home = os.homedir();
    const base = fs.mkdtempSync(path.join(home, '.taskpilot-sandbox-test-'));
    onTestFinished(() => fs.rmSync(base, { recursive: true, force: true }));
    const runDir = path.join(base, 'coding-runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(`${runDir}-home`);
    const context: sandbox.SandboxContext = {
      home,
      runRoot: path.join(base, 'coding-runs'),
      probeFile: '',
      pathEntries: ['/usr/bin', '/bin'],
      extraRead: [],
      extraWrite: [],
    };
    const profile = sandbox.buildProfile(sandbox.profileFor(context, 'claude', runDir, null));
    const sh = (script: string) =>
      spawnSync(sandbox.SANDBOX_EXEC_PATH, ['-p', profile, '/bin/sh', '-c', script], { cwd: runDir, env: sandbox.sandboxEnv(context, {}, `${runDir}-home`) });
    for (const state of ['.claude', '.codex', '.npm', '.config/opencode']) {
      const target = path.join(home, state, `taskpilot-escape-${process.pid}`);
      assert.notEqual(sh(`echo x > '${target}'`).status, 0, `write ${state}`);
      assert.equal(fs.existsSync(target), false, state);
    }
    assert.notEqual(sh(`cat '${path.join(home, '.claude.json')}'`).status, 0, 'read ~/.claude.json');
    // The run's own home is writable, which is where the CLI keeps its state now.
    assert.equal(sh('mkdir -p "$HOME/.claude" && echo ok > "$HOME/.claude/x"').status, 0);
    assert.equal(fs.readFileSync(path.join(`${runDir}-home`, '.claude', 'x'), 'utf8'), 'ok\n');
  },
);

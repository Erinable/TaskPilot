/** @module-tag integration */
// IPC channels of the settings domain (src/main/ipc/settings.ts).
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentDeps } from '../../../src/main/app/app_context.ts';
import type { CliModelCatalog } from '../../../src/shared/agent_runtime.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
import * as fixtures from './harness.ts';

test('agent model IPC isolates scopes, caches local catalogs, and refreshes only the requested catalog', async () => {
  const reads: string[] = [];
  const modelCatalog: NonNullable<AgentDeps['modelCatalog']> = async (cli, scope): Promise<CliModelCatalog> => {
    reads.push(`${scope}:${cli}`);
    return { cli, scope, models: [], defaultModel: `${scope}-${cli}-${reads.length}`, defaultThinking: null, issues: [] };
  };
  const { call } = await fixtures.harness({ withRepo: false, modelCatalog });
  const analysis = { ok: true, data: { cli: 'pi', scope: 'analysis', models: [], defaultModel: 'analysis-pi-1', defaultThinking: null, issues: [] } };
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis' }), analysis);
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis' }), analysis);
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'coding' }), {
    ok: true,
    data: { cli: 'pi', scope: 'coding', models: [], defaultModel: 'coding-pi-2', defaultThinking: null, issues: [] },
  });
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis', refresh: true }), {
    ok: true,
    data: { cli: 'pi', scope: 'analysis', models: [], defaultModel: 'analysis-pi-3', defaultThinking: null, issues: [] },
  });
  const invalid = await call(CHANNELS.agentModels, { cli: 'not-a-cli', scope: 'analysis' });
  assert.equal(invalid.ok, false);
  assert.deepEqual(reads, ['analysis:pi', 'coding:pi', 'analysis:pi']);
});

test('agent model IPC uses the Coding Agent account for coding catalogs', async () => {
  const reads: unknown[] = [];
  const modelCatalog: NonNullable<AgentDeps['modelCatalog']> = async (cli, scope, options): Promise<CliModelCatalog> => {
    reads.push([scope, options?.separateUser]);
    return { cli, scope, models: [], defaultModel: null, defaultThinking: null, issues: [] };
  };
  const h = await fixtures.harness({ withRepo: false, modelCatalog });
  await h.call(CHANNELS.agentModels, { cli: 'codex', scope: 'coding' });
  await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ coding: { isolation: 'sandbox', extraRead: [], extraWrite: [] } }));
  await h.call(CHANNELS.agentModels, { cli: 'codex', scope: 'coding' });
  assert.deepEqual(reads, [
    ['coding', true],
    ['coding', false],
  ]);
});

test('environment:info refreshes the cached PATH used by the next verification command', async () => {
  const { call, setShellPathPrefix, setCommands } = await fixtures.harness();
  setShellPathPrefix('/tp/first/bin');
  assert.equal((await call(CHANNELS.environmentInfo, { source: 'login-shell' })).data.entries[0], '/tp/first/bin');
  setShellPathPrefix('/tp/second/bin');
  assert.equal((await call(CHANNELS.environmentInfo, { source: 'login-shell' })).data.entries[0], '/tp/first/bin');
  assert.equal((await call(CHANNELS.environmentInfo, { source: 'login-shell', refresh: true })).data.entries[0], '/tp/second/bin');
  await call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'login-shell' } }));
  setCommands({ test: { command: process.execPath, args: ['-e', 'console.log(process.env.PATH)'] } });
  assert.match((await call(CHANNELS.verifyRun, 'test')).data.output, /^\/tp\/second\/bin:/);
});

test('agent:status reports sign-in for the analysis CLI and the coding CLI, checking a shared CLI once', async () => {
  const checked: string[] = [];
  const { call } = await fixtures.harness({
    coding: {
      checkSignIn: async (cli) => {
        checked.push(cli);
        return cli === 'codex' ? { state: 'signed_out', source: null } : { state: 'signed_in', source: 'claude auth status' };
      },
    },
  });
  const status = (await call(CHANNELS.agentStatus)).data;
  assert.equal(status.available, true);
  assert.deepEqual(status.signIn, { state: 'signed_in', source: 'claude auth status' });
  // The fake PATH has no codex, so it is reported as not installed and not checked.
  assert.deepEqual(status.coding, { cli: 'codex', installed: false, signIn: null });
  assert.deepEqual(checked, ['claude']);
  // With the coding CLI on the PATH it is checked too.
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-bin-'));
  onTestFinished(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  checked.length = 0;
  const withCodex = await fixtures.harness({
    coding: { checkSignIn: async (cli) => (checked.push(cli), cli === 'codex' ? { state: 'signed_out', source: null } : { state: 'signed_in', source: 'x' }) },
  });
  withCodex.setShellPathPrefix(bin);
  assert.equal((await withCodex.call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'login-shell' } }))).ok, true);
  assert.deepEqual((await withCodex.call(CHANNELS.agentStatus)).data.coding, { cli: 'codex', installed: true, signIn: { state: 'signed_out', source: null } });
  assert.deepEqual(checked.sort(), ['claude', 'codex']);

  // A missing analysis CLI is not checked for sign-in.
  checked.length = 0;
  const offline = await fixtures.harness({
    coding: {
      probeAgent: async (config) => ({ command: config.cli, available: false, version: null, reason: 'missing' }),
      checkSignIn: async (cli) => (checked.push(cli), { state: 'unknown', source: null }),
    },
  });
  const missing = (await offline.call(CHANNELS.agentStatus)).data;
  assert.equal(missing.signIn, null);
  assert.ok(!checked.includes('claude'));
});

test('data:reset-progress clears execution state but keeps config and preferences', async () => {
  const { call, configDir, repoDir, root } = await fixtures.harness();
  await call(CHANNELS.workspaceSet, {
    root,
    steps: { test: { enabled: true, lines: ['npm test'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null } },
  });
  await call(CHANNELS.preferencesSet, fixtures.validPrefs());
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  assert.equal((await call(CHANNELS.dataInfo)).data.packages.claimed, 1);

  const { data } = await call(CHANNELS.dataResetProgress);
  assert.equal(data.claimed, 0);
  assert.equal((await call(CHANNELS.tasksGet, 'auth-edge-tests')).data.status, 'pending');
  assert.equal((await workspace.load(repoDir)).steps.test!.commands[0].command, 'npm');
  assert.equal((await preferences.load(configDir)).profile.displayName, 'Ada Lovelace');
});

test('data:reveal only ever opens the config directory', async () => {
  const { call, configDir, revealed } = await fixtures.harness();
  // Arguments from the renderer are ignored.
  await handlersCall(call, CHANNELS.dataReveal, '/etc');
  assert.deepEqual(revealed, [configDir]);
});

const handlersCall = async (call, channel, ...args) => {
  const response = await call(channel, ...args);
  assert.equal(response.ok, true);
  return response.data;
};

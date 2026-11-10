/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { createPathResolver, ShellEnvError } from '../../../src/main/infrastructure/shell_env.ts';
import { resolveExecutable } from '../../../src/main/repository/workspace.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type { AgentDeps } from '../../../src/main/app/app_context.ts';
import type { SandboxContext } from '../../../src/main/coding/coding_sandbox.ts';
import * as fixtures from './harness.ts';

const resultOf = <T>(result: IpcResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

const installedTools = async () => {
  const root = await tempDir('taskpilot-runtime-ipc-');
  const cliDirectory = path.join(root, 'cli tools');
  const nodeDirectory = path.join(root, 'node tools');
  const marker = path.join(root, 'unexpected-execution');
  await Promise.all([fs.mkdir(cliDirectory), fs.mkdir(nodeDirectory)]);
  const cli = path.join(cliDirectory, 'claude');
  await fs.writeFile(cli, '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(91);\nconsole.log("runtime-discovery-fixture");\n', {
    mode: 0o755,
  });
  await fs.symlink(process.execPath, path.join(nodeDirectory, 'node'));
  return { root, cliDirectory, nodeDirectory, marker, cli };
};

const pathProbe =
  (paths: string[]): NonNullable<AgentDeps['probeAgent']> =>
  async (config, envPath) => {
    paths.push(envPath ?? '');
    const command = await resolveExecutable(config.cli, { envPath: envPath ?? '' });
    return { command: config.cli, available: command !== null, version: command ? 'fixture-version' : null, reason: command ? null : 'missing fixture CLI' };
  };

test('Finder-style automatic discovery inventories separate CLI and Node directories without starting a shell or a model', async () => {
  const tools = await installedTools();
  let shellReads = 0;
  const h = await fixtures.harness({
    withRepo: false,
    pathResolver: createPathResolver({
      inherited: '/tp/minimal-inherited',
      discover: async () => [tools.cliDirectory, tools.nodeDirectory],
      read: async () => {
        shellReads += 1;
        throw new Error('automatic mode must never run rc files');
      },
    }),
  });
  assert.equal(resultOf(await h.api.preferences.get()).environment.pathSource, 'auto');
  const info = resultOf(await h.api.environment.info());
  assert.equal(info.requested, 'auto');
  assert.equal(info.source, 'auto');
  assert.equal(info.error, null);
  assert.deepEqual(info.entries, ['/tp/minimal-inherited', tools.cliDirectory, tools.nodeDirectory]);
  const cli = info.tools?.find((tool) => tool.id === 'claude');
  assert.equal(cli?.path, tools.cli);
  assert.equal(cli?.requiresNode, true);
  assert.equal(cli?.problem, null);
  assert.equal(info.tools?.find((tool) => tool.id === 'node')?.realPath, await fs.realpath(process.execPath));
  assert.equal(shellReads, 0);
  assert.deepEqual(h.agentCalls, []);
});

test('login-shell timeout still exposes discovered tools and manual paths and does not rerun the failed shell for each lookup', async () => {
  const tools = await installedTools();
  let reads = 0;
  const h = await fixtures.harness({
    withRepo: false,
    pathResolver: createPathResolver({
      inherited: '/tp/minimal-inherited',
      discover: async () => [tools.cliDirectory, tools.nodeDirectory],
      read: async () => {
        reads += 1;
        throw new ShellEnvError('fixture shell timeout', 'shell_timeout');
      },
    }),
  });
  const options = { source: 'login-shell' as const, extraPaths: ['/tp/manual-priority'] };
  const first = resultOf(await h.api.environment.info(options));
  const second = resultOf(await h.api.environment.info(options));
  assert.equal(first.error?.code, 'shell_timeout');
  assert.deepEqual(first.entries, ['/tp/manual-priority', '/tp/minimal-inherited', tools.cliDirectory, tools.nodeDirectory]);
  assert.equal(first.tools?.find((tool) => tool.id === 'claude')?.problem, null);
  assert.deepEqual(second, first);
  assert.equal(reads, 1);
  resultOf(await h.api.environment.info({ ...options, refresh: true }));
  assert.equal(reads, 2);
  assert.deepEqual(h.agentCalls, []);
});

test('a path preview is not saved, while saving manual directories updates analysis, sign-in, coding and real verification together', async () => {
  const tools = await installedTools();
  const probePaths: string[] = [];
  const signInPaths: string[] = [];
  const codingContexts: (SandboxContext | undefined)[] = [];
  const h = await fixtures.harness({
    pathResolver: createPathResolver({ inherited: '/tp/minimal-inherited', discover: async () => [] }),
    coding: {
      probeAgent: pathProbe(probePaths),
      checkSignIn: async (_cli, options) => {
        signInPaths.push(options?.envPath ?? '');
        return { state: 'signed_in', source: 'fixture' };
      },
      codingProbe: async (options) => {
        codingContexts.push(options?.sandbox);
        return fixtures.codingRuntime({ boundary: 'sandbox' });
      },
    },
  });
  const extraPaths = [tools.cliDirectory, tools.nodeDirectory];
  const preview = resultOf(await h.api.environment.info({ source: 'auto', extraPaths }));
  assert.equal(preview.tools?.find((tool) => tool.id === 'claude')?.path, tools.cli);
  assert.equal(resultOf(await h.api.agent.status()).available, false);
  assert.deepEqual(resultOf(await h.api.preferences.get()).environment, { pathSource: 'auto' });
  assert.ok(probePaths.every((value) => value === '/tp/minimal-inherited'));

  assert.equal(
    (await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'auto', extraPaths }, coding: { isolation: 'sandbox' } }))).ok,
    true,
  );
  const expected = [...extraPaths, '/tp/minimal-inherited'].join(path.delimiter);
  probePaths.length = 0;
  assert.equal(resultOf(await h.api.agent.status()).available, true);
  resultOf(await h.api.agent.runtimes());
  assert.ok(probePaths.length > 0 && probePaths.every((value) => value === expected));
  assert.ok(signInPaths.length > 0 && signInPaths.every((value) => value === expected));
  assert.deepEqual(codingContexts.at(-1)?.pathEntries, [...extraPaths, '/tp/minimal-inherited']);
  h.setCommands({ test: { command: 'claude', args: ['--version'] } });
  const check = resultOf(
    await h.api.workspace.check({
      root: h.root,
      steps: {
        test: { enabled: true, lines: ['claude --version'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'exitcode' }, timeoutSeconds: null },
      },
    }),
  );
  assert.equal(check.steps.test?.resolved, tools.cli);
  const verification = resultOf(await h.api.verify.run('test'));
  assert.equal(verification.exitCode, 0, verification.output);
  assert.equal(verification.output.trim(), 'runtime-discovery-fixture');
  assert.deepEqual((await preferences.load(h.configDir)).environment, { pathSource: 'auto', extraPaths });
  const replacement = await installedTools();
  const changedPaths = [replacement.cliDirectory, replacement.nodeDirectory];
  assert.equal(
    (
      await h.call(
        CHANNELS.preferencesSet,
        fixtures.validPrefs({ environment: { pathSource: 'auto', extraPaths: changedPaths }, coding: { isolation: 'sandbox' } }),
      )
    ).ok,
    true,
  );
  probePaths.length = 0;
  signInPaths.length = 0;
  assert.equal(resultOf(await h.api.agent.status()).available, true);
  const changedPath = [...changedPaths, '/tp/minimal-inherited'].join(path.delimiter);
  assert.ok(probePaths.length > 0 && probePaths.every((value) => value === changedPath));
  assert.ok(signInPaths.length > 0 && signInPaths.every((value) => value === changedPath));
  h.setCommands({ test: { command: process.execPath, args: ['-e', 'console.log(process.env.PATH)'] } });
  assert.equal(resultOf(await h.api.verify.run('test')).output.trim(), changedPath);
  assert.deepEqual(h.agentCalls, []);
});

test('a CLI with an env-node shebang is reported installed but needs Node until its separate directory is added', async () => {
  const tools = await installedTools();
  const h = await fixtures.harness({ withRepo: false, pathResolver: createPathResolver({ inherited: '/tp/minimal-inherited', discover: async () => [] }) });
  const onlyCli = resultOf(await h.api.environment.info({ source: 'auto', extraPaths: [tools.cliDirectory] }));
  const cli = onlyCli.tools?.find((tool) => tool.id === 'claude');
  assert.equal(cli?.path, tools.cli);
  assert.equal(cli?.requiresNode, true);
  assert.match(cli?.problem ?? '', /Node\.js/);
  assert.equal(onlyCli.tools?.find((tool) => tool.id === 'node')?.path, null);
  const ready = resultOf(await h.api.environment.info({ source: 'auto', extraPaths: [tools.cliDirectory, tools.nodeDirectory] }));
  assert.equal(ready.tools?.find((tool) => tool.id === 'claude')?.problem, null);
  assert.deepEqual(h.agentCalls, []);
});

test('manual executable selection preserves a standard symlink entry and does not save or execute it', async () => {
  const tools = await installedTools();
  const executable = path.join(tools.root, 'renamed-entry');
  await fs.rename(tools.cli, executable);
  await fs.writeFile(executable, `#!/bin/sh\ntouch '${tools.marker}'\n`, { mode: 0o755 });
  await fs.symlink(executable, tools.cli);
  let selected: string | null = tools.cli;
  const h = await fixtures.harness({ withRepo: false, coding: { pickFile: async () => selected } });
  assert.deepEqual(resultOf(await h.api.environment.pickExecutable('claude')), { path: tools.cli, directory: tools.cliDirectory });
  assert.deepEqual(resultOf(await h.api.preferences.get()).environment, { pathSource: 'auto' });
  await assert.rejects(fs.access(tools.marker), { code: 'ENOENT' });
  selected = path.join(tools.nodeDirectory, 'node');
  assert.deepEqual(resultOf(await h.api.environment.pickExecutable('node')), { path: selected, directory: tools.nodeDirectory });
  selected = null;
  assert.equal(resultOf(await h.api.environment.pickExecutable('claude')), null);
  assert.deepEqual(h.agentCalls, []);
});

test('manual executable selection refuses unknown tools, renamed binaries, directories and files without execution permission', async () => {
  const tools = await installedTools();
  let selected = tools.nodeDirectory;
  let picks = 0;
  const h = await fixtures.harness({
    withRepo: false,
    coding: {
      pickFile: async () => {
        picks += 1;
        return selected;
      },
    },
  });
  const unknown = await h.call(CHANNELS.environmentPickExecutable, 'bash');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'invalid_argument');
  assert.equal(picks, 0);
  const renamed = path.join(tools.cliDirectory, 'claude-custom');
  await fs.copyFile(tools.cli, renamed);
  selected = renamed;
  const wrongName = await h.api.environment.pickExecutable('claude');
  assert.equal(wrongName.ok, false);
  if (!wrongName.ok) assert.match(wrongName.error.message, /claude/);
  const directory = path.join(tools.root, 'directory', 'claude');
  await fs.mkdir(directory, { recursive: true });
  selected = directory;
  assert.equal((await h.api.environment.pickExecutable('claude')).ok, false);
  await fs.chmod(tools.cli, 0o600);
  selected = tools.cli;
  assert.equal((await h.api.environment.pickExecutable('claude')).ok, false);
  assert.deepEqual(h.agentCalls, []);
});

test('environment preview and preferences refuse unsafe manual PATH directories without writing them', async () => {
  const h = await fixtures.harness({ withRepo: false });
  for (const extraPaths of [['relative/bin'], ['/'], ['/a:/b'], ['/a\nb'], 'not an array']) {
    const preview = await h.call(CHANNELS.environmentInfo, { source: 'auto', extraPaths });
    assert.equal(preview.ok, false);
    const saved = await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ environment: { pathSource: 'auto', extraPaths } }));
    assert.equal(saved.ok, false);
  }
  assert.deepEqual(resultOf(await h.api.preferences.get()).environment, { pathSource: 'auto' });
});

/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { assertCodexHostConfig } from '../../../src/main/runtimes/codex_host_config.ts';

const rejected = async (operation: Promise<void>) =>
  assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code: unknown }).code, 'agent_unavailable');
    assert.match((error as Error).message, /托管 Codex 配置/);
    assert.match((error as Error).message, /编码模式仍可使用/);
    assert.doesNotMatch((error as Error).message, /policy-secret|raw-managed-value/);
    return true;
  });

test('Codex restricted host guard accepts absent system configuration and an unconfigured managed domain', async () => {
  const root = await tempDir('taskpilot-codex-host-');
  let managedCalls = 0;
  await assertCodexHostConfig({
    systemRoots: [path.join(root, 'missing')],
    platform: 'darwin',
    readManaged: async () => {
      managedCalls += 1;
      return false;
    },
  });
  assert.equal(managedCalls, 1);
  await assertCodexHostConfig({
    systemRoots: [],
    platform: 'linux',
    readManaged: async () => assert.fail('macOS preference check must not run on another platform'),
  });
});

for (const name of ['config.toml', 'requirements.toml', 'managed_config.toml', 'skills', 'hooks.json', 'plugins']) {
  test(`Codex restricted host guard rejects existing system entry ${name} without reading it`, async () => {
    const root = await tempDir('taskpilot-codex-host-');
    const file = path.join(root, name);
    if (name === 'skills' || name === 'plugins') await fs.mkdir(file);
    else await fs.writeFile(file, 'policy-secret', { mode: 0o000 });
    await rejected(
      assertCodexHostConfig({
        systemRoots: [root],
        platform: 'darwin',
        readManaged: async () => assert.fail('system policy must reject before preferences are read'),
      }),
    );
    if (name !== 'skills' && name !== 'plugins') await fs.chmod(file, 0o600);
  });
}

test('Codex restricted host guard treats dangling links, unreadable policy state and managed values as unavailable', async () => {
  const root = await tempDir('taskpilot-codex-host-');
  await fs.symlink(path.join(root, 'missing-config'), path.join(root, 'config.toml'));
  await rejected(assertCodexHostConfig({ systemRoots: [root], platform: 'linux' }));
  const notDirectory = path.join(root, 'not-a-directory');
  await fs.writeFile(notDirectory, 'policy-secret');
  await rejected(assertCodexHostConfig({ systemRoots: [notDirectory], platform: 'linux' }));
  await rejected(assertCodexHostConfig({ systemRoots: [], platform: 'darwin', readManaged: async () => true }));
  await rejected(
    assertCodexHostConfig({
      systemRoots: [],
      platform: 'darwin',
      readManaged: async () => {
        throw new Error('raw-managed-value');
      },
    }),
  );
});

/** @module-tag integration */
import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { harness, validPrefs } from './harness.ts';

test('status preserves each configured planning role and checks Architect sign-in independently', async () => {
  const checked: string[] = [];
  const h = await harness({
    withRepo: false,
    coding: {
      checkSignIn: async (cli) => {
        checked.push(cli);
        return { state: cli === 'opencode' ? 'signed_out' : 'signed_in', source: cli };
      },
    },
  });
  const prefs = validPrefs();
  prefs.agents['product-lead'].cli = 'pi';
  prefs.agents.architect.cli = 'opencode';
  prefs.agents.tutor.cli = 'pi';
  expect((await h.call(CHANNELS.preferencesSet, prefs)).ok).toBe(true);
  const result = await h.api.agent.status();
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.analysis['product-lead']).toMatchObject({ cli: 'pi', available: true, signIn: { state: 'signed_in' } });
  expect(result.data.analysis.architect).toMatchObject({ cli: 'opencode', available: true, signIn: { state: 'signed_out' } });
  expect(result.data.tutor).toMatchObject({ cli: 'pi', signIn: { state: 'signed_in' } });
  expect(result.data.signIn?.state).toBe('signed_out');
  expect(checked.sort()).toEqual(['opencode', 'pi']);
});

test('a missing role does not hide the other role or its required login', async () => {
  const checked: string[] = [];
  const h = await harness({
    withRepo: false,
    coding: {
      probeAgent: async (config) => ({ command: config.cli, available: config.cli !== 'pi', version: null, reason: config.cli === 'pi' ? 'missing' : null }),
      checkSignIn: async (cli) => {
        checked.push(cli);
        return { state: 'signed_out', source: null };
      },
    },
  });
  const prefs = validPrefs();
  prefs.agents['product-lead'].cli = 'pi';
  prefs.agents.architect.cli = 'opencode';
  prefs.agents.tutor.cli = 'opencode';
  await h.call(CHANNELS.preferencesSet, prefs);
  const result = await h.api.agent.status();
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.available).toBe(false);
  expect(result.data.analysis['product-lead']).toMatchObject({ cli: 'pi', installed: false, available: false, signIn: null });
  expect(result.data.analysis.architect).toMatchObject({ cli: 'opencode', installed: true, signIn: { state: 'signed_out' } });
  expect(checked).toEqual(['opencode']);
});

test('an installed incompatible runtime is distinguished from a missing executable', async () => {
  const bin = await tempDir('taskpilot-status-bin-');
  await fs.writeFile(path.join(bin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  const h = await harness({
    withRepo: false,
    coding: {
      probeAgent: async (config) => ({ command: config.cli, available: config.cli !== 'opencode', version: null, reason: 'Requires version 1.x' }),
    },
  });
  h.setShellPathPrefix(bin);
  const prefs = validPrefs({ environment: { pathSource: 'login-shell' } });
  prefs.agents.architect.cli = 'opencode';
  await h.call(CHANNELS.preferencesSet, prefs);
  const result = await h.api.agent.status();
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.analysis.architect).toMatchObject({ cli: 'opencode', installed: true, available: false, reason: 'Requires version 1.x' });
});

// Repositories created by the application need an identity before their first
// commit. Keep tests independent of the runner's Git config and inferred author.
import fs from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished, vi } from 'vitest';

import { tempDir } from './temp_dir.ts';

export const useGitIdentity = async ({ configured = true } = {}) => {
  const config = path.join(await tempDir('taskpilot-git-config-'), 'gitconfig');
  await fs.writeFile(config, `[user]\n\tuseConfigOnly = true\n${configured ? '\tname = Test\n\temail = test@example.com\n' : ''}`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) vi.stubEnv(name, undefined);
  onTestFinished(() => void vi.unstubAllEnvs());
};

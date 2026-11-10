// Codex still loads system/managed layers with --ignore-user-config. They may
// add MCP, hooks, skills or enforced tool settings before inference. Restricted
// analysis refuses such hosts conservatively; coding remains a separate mode.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AgentRunError } from './claude_cli.ts';

const SYSTEM_ENTRIES = ['config.toml', 'requirements.toml', 'managed_config.toml', 'skills', 'hooks.json', 'plugins'];
const MANAGED_KEYS = ['config_toml_base64', 'requirements_toml_base64'];
const UNAVAILABLE =
  '检测到系统或托管 Codex 配置，无法证明分析工具已完全关闭。Codex 编码模式仍可使用；请联系管理员确认受限分析环境，或为分析角色选择其他 CLI。不要删除或修改系统策略来绕过此检查。';

const readMacManagedConfig = (): Promise<boolean> =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/defaults', ['read', 'com.openai.codex'], { timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        // Do not parse, return or log configuration values, which may be private.
        resolve(MANAGED_KEYS.some((key) => new RegExp(`(?:^|[\\s;{])"?${key}"?\\s*=`, 'm').test(stdout)));
        return;
      }
      if (error.code === 1 && /(?:domain|Domain)[\s\S]*does not exist/.test(stderr)) {
        resolve(false);
        return;
      }
      reject(new Error('Cannot determine whether macOS has managed Codex configuration'));
    });
  });

export type CodexHostConfigOptions = {
  systemRoots?: readonly string[];
  platform?: NodeJS.Platform;
  // Returns true when managed/config preference keys are present. The raw
  // configuration never crosses this boundary or enters an error message.
  readManaged?: () => Promise<boolean>;
};

export const assertCodexHostConfig = async ({
  systemRoots = ['/etc/codex'],
  platform = process.platform,
  readManaged = readMacManagedConfig,
}: CodexHostConfigOptions = {}): Promise<void> => {
  try {
    for (const root of systemRoots) {
      if (!path.isAbsolute(root)) throw new Error('Codex system configuration root must be absolute');
      for (const name of SYSTEM_ENTRIES) {
        try {
          await fs.lstat(path.join(root, name));
          throw new AgentRunError(UNAVAILABLE, 'agent_unavailable');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    if (platform === 'darwin' && (await readManaged())) throw new AgentRunError(UNAVAILABLE, 'agent_unavailable');
  } catch {
    // A permission error or timed-out policy probe is not evidence of absence.
    // Use one actionable message, and never include a configuration's content.
    throw new AgentRunError(UNAVAILABLE, 'agent_unavailable');
  }
};

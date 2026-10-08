// Reads only predefined native config files as the dedicated coding user.
// The stdout may include provider credentials: it is parsed in main and never
// returned through IPC, printed, or attached to an error.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { CODING_USER, CODING_WRAPPER_PATH, SUDO_PATH, safeChildEnv } from './coding_exec.ts';
import { parseNativeContent } from './cli_native_config.ts';
import type { NativeObjectResult } from './cli_native_config.ts';
import type { CliId } from '../shared/agent_runtime.ts';

export const CODING_HOME = '/Users/taskpilot-coder';
const KINDS: Record<CliId, Record<string, string>> = {
  pi: { 'models.json': 'primary', 'settings.json': 'auxiliary' },
  opencode: { 'opencode.json': 'primary', 'opencode.jsonc': 'comments' },
  grok: { 'config.toml': 'primary', 'managed_config.toml': 'managed' },
  codex: { 'config.toml': 'primary', 'models_cache.json': 'auxiliary' },
  claude: { 'settings.json': 'primary' },
};
export const codingModelConfigReader =
  (cli: CliId) =>
  async (file: string, format: 'json' | 'toml'): Promise<NativeObjectResult> => {
    const kind = KINDS[cli][path.basename(file)];
    if (!kind) return { data: {}, found: false, issue: '不支持的编码 CLI 配置文件。' };
    const { promise, resolve } = Promise.withResolvers<NativeObjectResult>();
    execFile(
      SUDO_PATH,
      ['-n', '-H', '-u', CODING_USER, CODING_WRAPPER_PATH, 'model-config', cli, kind],
      {
        env: safeChildEnv(),
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          resolve({ data: {}, found: false, issue: '无法读取编码账号的 CLI 配置；请检查 taskpilot-coder 和已部署 wrapper。' });
          return;
        }
        if (!stdout.trim()) resolve({ data: {}, found: false, issue: null });
        else resolve(parseNativeContent(stdout, file, format));
      },
    );
    return promise;
  };

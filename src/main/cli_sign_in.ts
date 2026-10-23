// Whether a CLI has credentials it can use, checked offline: no model call,
// no network, nothing that costs money. A credential that is present but
// expired or rejected only shows on the first real call.
//
// [人工决策-2026-10-24 07:20:48] 登录检查走「多源判断，查不清的不拦」：CLI 自己的状态命令、环境变量里的 key、配置文件里的 key 或 apiKeyHelper、凭据文件，任一处有就算已登录；没有离线检查方式的 CLI 记为 unknown，只提示不拦截。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processEnv } from './env.ts';
import type { CliId } from '../shared/agent_runtime.ts';
import type { CliSignIn } from '../shared/ipc_types.ts';

// The keys each CLI reads from the environment. Any one of them counts.
const ENV_KEYS: Record<CliId, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  pi: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY'],
  grok: ['XAI_API_KEY'],
  opencode: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY'],
};

// Credential files, relative to home: a non-empty JSON object counts.
const CREDENTIAL_FILES: Record<CliId, string[]> = {
  claude: ['.claude/.credentials.json'],
  codex: ['.codex/auth.json'],
  pi: ['.pi/agent/auth.json'],
  grok: ['.grok/auth.json'],
  opencode: ['.local/share/opencode/auth.json'],
};

const STATUS_TIMEOUT_MS = 15_000;

// Runs a status command; null when it could not run at all.
export type StatusRunner = (command: string, args: string[], envPath: string | null) => Promise<{ code: number; stdout: string } | null>;

const runStatus: StatusRunner = (command, args, envPath) =>
  new Promise((resolve) => {
    const env = { ...processEnv(), ...(envPath ? { PATH: envPath } : {}), NO_COLOR: '1', TERM: 'dumb' };
    const child = execFile(command, args, { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') return resolve(null);
      resolve({ code: error ? (error.code as number) : 0, stdout });
    });
    // Status commands never need input; an open stdin could hang one.
    child.stdin?.end();
  });

const readJsonObject = async (file: string): Promise<Record<string, unknown> | null> => {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim() !== '';

export type SignInOptions = { envPath?: string | null; home?: string; env?: NodeJS.ProcessEnv; run?: StatusRunner };

export const checkSignIn = async (
  cli: CliId,
  { envPath = null, home = os.homedir(), env = processEnv(), run = runStatus }: SignInOptions = {},
): Promise<CliSignIn> => {
  const keyInEnv = ENV_KEYS[cli].find((key) => nonEmpty(env[key]));
  if (keyInEnv) return { state: 'signed_in', source: `env:${keyInEnv}` };

  for (const file of CREDENTIAL_FILES[cli]) {
    const credentials = await readJsonObject(path.join(home, file));
    if (credentials && Object.keys(credentials).length) return { state: 'signed_in', source: `file:${file}` };
  }

  switch (cli) {
    case 'claude': {
      // A key or helper in settings.json is how API-key and proxy users sign in.
      const settings = await readJsonObject(path.join(home, '.claude', 'settings.json'));
      const settingsEnv = (settings?.env ?? {}) as Record<string, unknown>;
      const settingsKey = ENV_KEYS.claude.find((key) => nonEmpty(settingsEnv[key]));
      if (settingsKey) return { state: 'signed_in', source: `settings:${settingsKey}` };
      if (nonEmpty(settings?.apiKeyHelper)) return { state: 'signed_in', source: 'settings:apiKeyHelper' };
      const result = await run('claude', ['auth', 'status'], envPath);
      if (!result) return { state: 'unknown', source: null };
      try {
        return JSON.parse(result.stdout).loggedIn === true ? { state: 'signed_in', source: 'claude auth status' } : { state: 'signed_out', source: null };
      } catch {
        return { state: 'unknown', source: null };
      }
    }
    case 'codex': {
      const result = await run('codex', ['login', 'status'], envPath);
      if (!result) return { state: 'unknown', source: null };
      return result.code === 0 ? { state: 'signed_in', source: 'codex login status' } : { state: 'signed_out', source: null };
    }
    case 'opencode': {
      const result = await run('opencode', ['auth', 'list'], envPath);
      // NO_COLOR is set; the count sits on its own line either way.
      const count = result ? /(\d+)\s+credentials?\b/.exec(result.stdout) : null;
      if (!count) return { state: 'unknown', source: null };
      return Number(count[1]) > 0 ? { state: 'signed_in', source: 'opencode auth list' } : { state: 'signed_out', source: null };
    }
    // Pi checks need a provider name; Grok has no offline check. Neither
    // file was found, but a provider set up another way may still work.
    case 'pi':
    case 'grok':
      return { state: 'unknown', source: null };
  }
};

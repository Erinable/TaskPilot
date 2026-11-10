import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';

import { loadNativeConfig } from './cli_native_config.ts';
import { processEnv } from '../infrastructure/env.ts';
import { AgentRunError } from './claude_cli.ts';
import { writeFileAtomic } from '../infrastructure/atomic_json_file.ts';
import type { NativeConfigOptions } from './cli_native_config.ts';
import type { ThinkingLevel } from '../../shared/agent_runtime.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const PROVIDER_FIELDS = [
  'name',
  'base_url',
  'env_key',
  'env_key_instructions',
  'wire_api',
  'query_params',
  'http_headers',
  'env_http_headers',
  'requires_openai_auth',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
  'supports_websockets',
  'experimental_bearer_token',
];
const MODEL_FIELDS = [
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_context_window',
  'model_auto_compact_token_limit',
];
const pick = (source: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));

const credentialWrites = new Map<string, Promise<void>>();
const syncCredentials = (source: string, snapshot: string, temporary: string) => {
  const previous = credentialWrites.get(source) ?? Promise.resolve();
  const writing = previous
    .catch(() => {})
    .then(async () => {
      const current = await fs.readFile(source, 'utf8');
      const info = await fs.stat(temporary);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Codex refreshed credentials exceed the supported size');
      const refreshed = await fs.readFile(temporary, 'utf8');
      if (current !== snapshot || refreshed === snapshot) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(refreshed);
      } catch {
        throw new Error('Codex refreshed credentials are invalid');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex refreshed credentials are invalid');
      await writeFileAtomic(source, refreshed, { mode: 0o600 });
    })
    .finally(() => {
      if (credentialWrites.get(source) === writing) credentialWrites.delete(source);
    });
  credentialWrites.set(source, writing);
  return writing;
};

const projectInferenceConfig = (data: Record<string, unknown>) => {
  const selectedProfile = text(data.profile);
  const profile = selectedProfile ? object(object(data.profiles)[selectedProfile]) : {};
  const modelSettings = { ...pick(data, MODEL_FIELDS), ...pick(profile, MODEL_FIELDS) };
  if (
    Object.hasOwn(modelSettings, 'model_reasoning_effort') &&
    !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(modelSettings.model_reasoning_effort))
  )
    delete modelSettings.model_reasoning_effort;
  const provider = text(modelSettings.model_provider) ?? 'openai';
  const providerConfig = object(object(data.model_providers)[provider]);
  if (Object.hasOwn(providerConfig, 'auth_provider_command') || Object.hasOwn(providerConfig, 'api_key_command'))
    throw new AgentRunError('Codex 受限分析不运行配置中的凭据命令，请使用 CLI 登录或环境变量凭据。', 'agent_unavailable');
  return { modelSettings, provider, projected: pick(providerConfig, PROVIDER_FIELDS) };
};

const credentialEnvironment = (projected: Record<string, unknown>, source: NodeJS.ProcessEnv) => {
  const environment: NodeJS.ProcessEnv = {};
  const keys = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY']);
  if (typeof projected.env_key === 'string') keys.add(projected.env_key);
  for (const value of Object.values(object(projected.env_http_headers))) if (typeof value === 'string') keys.add(value);
  for (const key of keys) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|TMPDIR|TMP|TEMP|CODEX_HOME|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/.test(key) ||
      /^(?:XDG_|DYLD_|LD_)/.test(key)
    )
      throw new AgentRunError('Codex 凭据变量不能覆盖进程运行环境，请使用独立的 API Key 或 Token 环境变量。', 'agent_unavailable');
    if (source[key]) environment[key] = source[key];
  }
  return environment;
};

const copyCredentials = async (source: string, directory: string) => {
  try {
    const file = await fs.realpath(path.join(source, 'auth.json'));
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new AgentRunError('Codex 凭据文件不是普通文件或超过读取上限。', 'agent_unavailable');
    const credentials = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(credentials);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AgentRunError('Codex 凭据格式无效，请重新运行 codex login。', 'agent_unavailable');
    const temporary = path.join(directory, 'auth.json');
    await fs.writeFile(temporary, credentials, { mode: 0o600 });
    return () => syncCredentials(file, credentials, temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return async () => {};
    if (error instanceof SyntaxError) throw new AgentRunError('Codex 凭据格式无效，请重新运行 codex login。', 'agent_unavailable');
    throw error;
  }
};

// Analysis receives a new CODEX_HOME with inference settings and credentials
// only. User hooks, MCP, skills, rules and instruction files are never copied.
export const prepareCodexProfile = async (privateRoot: string, options: NativeConfigOptions = {}) => {
  const native = await loadNativeConfig('codex', options);
  if (native.issues.length) throw new AgentRunError(native.issues.join('; '), 'agent_unavailable');
  const sourceEnvironment = options.environment ?? processEnv();
  const sourceHome = options.home ?? sourceEnvironment.HOME ?? os.homedir();
  const source = !options.home && sourceEnvironment.CODEX_HOME ? sourceEnvironment.CODEX_HOME : path.join(sourceHome, '.codex');
  const { modelSettings, provider, projected } = projectInferenceConfig(native.data);
  const environment = credentialEnvironment(projected, sourceEnvironment);
  const directory = path.join(privateRoot, 'codex');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const config = { ...modelSettings, ...(Object.keys(projected).length ? { model_providers: { [provider]: projected } } : {}) };
  await fs.writeFile(path.join(directory, 'config.toml'), stringifyToml(config), { mode: 0o600 });
  const sync = await copyCredentials(source, directory);
  const cached = Array.isArray(native.auxiliary.models)
    ? native.auxiliary.models
        .map(object)
        .filter((entry) => typeof entry.slug === 'string' && entry.visibility !== 'hide')
        .sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100))
    : [];
  const model = text(modelSettings.model) ?? text(cached[0]?.slug);
  const effort = text(modelSettings.model_reasoning_effort);
  const thinking = effort && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? (effort as ThinkingLevel) : null;
  return { directory, environment, provider, model, metadata: cached, thinking, syncCredentials: sync };
};

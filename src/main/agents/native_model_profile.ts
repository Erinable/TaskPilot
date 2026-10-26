import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';

import type { CliId, ThinkingLevel } from '../../shared/agent_runtime.ts';
import { processEnv } from '../env.ts';
import { loadNativeConfig } from '../cli_native_config.ts';
import { CONTROL_CHARS } from '../../shared/text_rules.ts';

export type NativeModelProfile = {
  cli: CliId;
  defaultModel: string | null;
  defaultThinking: ThinkingLevel | null;
  claudeEnv: NodeJS.ProcessEnv;
  grokEnvironment: NodeJS.ProcessEnv;
  grokConfiguredApiKey: boolean;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const copyKeys = (source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) result[key] = source[key];
  return result;
};

// Custom provider code and command-based secrets are executable configuration,
// not inference metadata. Reject such profiles rather than silently omitting them.
const rejectExecutable = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const entry of value) rejectExecutable(entry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:auth_provider_command|api[_-]?key[_-]?command|credential_command)$/i.test(key) || (key === 'command' && typeof entry === 'string'))
      throw new Error('Native CLI configuration contains executable credential settings unsupported in isolated analysis');
    if (typeof entry === 'string' && /^\s*!/.test(entry) && /(?:key|token|auth|credential|command)/i.test(key))
      throw new Error('Native CLI configuration contains an unsupported credential command');
    rejectExecutable(entry);
  }
};

const PI_MODEL_FIELDS = [
  'id',
  'name',
  'api',
  'contextWindow',
  'maxTokens',
  'cost',
  'reasoning',
  'input',
  'headers',
  'baseUrl',
  'apiKey',
  'compatibility',
  'compat',
  'thinkingLevelMap',
  'samplingParams',
  'inputLimits',
];
const PI_PROVIDER_FIELDS = ['api', 'baseUrl', 'apiKey', 'headers', 'auth', 'compat', 'compatibility', 'thinkingLevelMap', 'samplingParams', 'inputLimits'];
const piProjection = (data: Record<string, unknown>): Record<string, unknown> => {
  if (Object.hasOwn(data, 'auth_provider_command')) throw new Error('Native Pi configuration contains an unsupported authentication command');
  const providers = object(data).providers;
  rejectExecutable(providers);
  const projectedProviders: Record<string, unknown> = Object.create(null);
  if (Array.isArray(providers)) {
    for (const value of providers) {
      const provider = object(value);
      if (typeof provider.id !== 'string') continue;
      const models = Array.isArray(provider.models) ? provider.models.map((model) => copyKeys(object(model), PI_MODEL_FIELDS)) : [];
      const projected = copyKeys(provider, PI_PROVIDER_FIELDS);
      projected.models = models;
      projectedProviders[provider.id] = projected;
    }
  } else {
    // Pi has historically represented providers as an id-keyed object.
    for (const [id, value] of Object.entries(object(providers))) {
      const provider = object(value);
      projectedProviders[id] = {
        ...copyKeys(provider, PI_PROVIDER_FIELDS),
        models: Array.isArray(provider.models) ? provider.models.map((model) => copyKeys(object(model), PI_MODEL_FIELDS)) : [],
      };
    }
  }
  return { providers: projectedProviders };
};

const SAFE_OPEN_CODE_SDKS: Record<string, true> = {
  '@ai-sdk/openai-compatible': true,
  '@ai-sdk/openai': true,
  '@ai-sdk/anthropic': true,
  '@ai-sdk/google': true,
  '@ai-sdk/google-vertex': true,
  '@ai-sdk/azure': true,
  '@ai-sdk/amazon-bedrock': true,
  '@ai-sdk/groq': true,
  '@ai-sdk/mistral': true,
  '@ai-sdk/xai': true,
};
const SAFE_OPEN_CODE_BUILTINS: Record<string, true> = {
  anthropic: true,
  openai: true,
  google: true,
  'google-vertex': true,
  azure: true,
  'amazon-bedrock': true,
  openrouter: true,
  xai: true,
  groq: true,
  mistral: true,
  deepseek: true,
  together: true,
  perplexity: true,
  cerebras: true,
  cohere: true,
  fireworks: true,
  deepinfra: true,
  moonshotai: true,
  minimax: true,
  zai: true,
  siliconflow: true,
  alibaba: true,
  'github-copilot': true,
};
const openCodeProjection = (data: Record<string, unknown>): Record<string, unknown> => {
  if (Object.hasOwn(data, 'auth_provider_command')) throw new Error('Native OpenCode configuration contains an unsupported authentication command');
  rejectExecutable(data.provider);
  const sourceProviders = object(data.provider);
  const provider: Record<string, unknown> = Object.create(null);
  for (const [id, raw] of Object.entries(sourceProviders)) {
    const item = object(raw);
    const hasNpm = Object.hasOwn(item, 'npm');
    if ((hasNpm && (typeof item.npm !== 'string' || !Object.hasOwn(SAFE_OPEN_CODE_SDKS, item.npm))) || (!hasNpm && !Object.hasOwn(SAFE_OPEN_CODE_BUILTINS, id)))
      throw new Error('Native OpenCode provider uses an unsupported SDK');
    const models: Record<string, unknown> = Object.create(null);
    for (const [modelId, rawModel] of Object.entries(object(item.models))) {
      const model = object(rawModel);
      if (Object.hasOwn(model, 'options') && /\{\s*file\s*:/i.test(JSON.stringify(model.options)))
        throw new Error('Native OpenCode configuration uses file-backed credentials');
      models[modelId] = copyKeys(model, ['name', 'tool_call', 'reasoning', 'attachment', 'temperature', 'limit', 'modalities', 'options', 'variants']);
    }
    const options = copyKeys(object(item.options), ['baseURL', 'apiKey', 'headers', 'timeout', 'maxRetries']);
    if (/\{\s*file\s*:/i.test(JSON.stringify(options))) throw new Error('Native OpenCode configuration uses file-backed credentials');
    provider[id] = {
      ...(hasNpm ? { npm: item.npm } : {}),
      ...(Object.hasOwn(item, 'name') ? { name: item.name } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      models,
    };
  }
  return {
    $schema: data.$schema,
    model: data.model,
    small_model: data.small_model,
    provider,
    permission: 'deny',
    tools: {},
    plugin: [],
    mcp: {},
  };
};

const GROK_MODEL_FIELDS = [
  'name',
  'model',
  'model_provider',
  'base_url',
  'api_backend',
  'env_key',
  'api_key',
  'extra_headers',
  'context',
  'context_window',
  'context_window_tokens',
  'options',
  'description',
  'reasoning_summary',
  'temperature',
  'top_p',
  'max_completion_tokens',
  'max_request_bytes',
  'query_params',
  'env_http_headers',
];
const GROK_GLOBAL_MODEL_FIELDS = [
  'extra_headers',
  'temperature',
  'top_p',
  'max_completion_tokens',
  'max_retries',
  'inference_idle_timeout_secs',
  'context_window',
  'context_window_tokens',
  'max_request_bytes',
  'stream_tool_calls',
];
const grokProjection = (data: Record<string, unknown>): Record<string, unknown> => {
  if (Object.hasOwn(data, 'auth_provider_command')) throw new Error('Native Grok configuration contains an unsupported authentication command');
  rejectExecutable(data.models);
  rejectExecutable(data.model);
  rejectExecutable(data.model_providers);
  const sourceModels = object(data.models);
  const models: Record<string, unknown> = Object.create(null);
  for (const key of GROK_GLOBAL_MODEL_FIELDS) if (Object.hasOwn(sourceModels, key)) models[key] = sourceModels[key];
  for (const key of ['default', 'small', 'default_reasoning_effort']) if (Object.hasOwn(sourceModels, key)) models[key] = sourceModels[key];
  if (Object.hasOwn(sourceModels, 'allowed_models')) {
    const allowed = sourceModels.allowed_models;
    if (!Array.isArray(allowed) || !allowed.every((value) => typeof value === 'string' && value.length <= 200 && !CONTROL_CHARS.test(value)))
      throw new Error('Native Grok configuration has an invalid allowed_models list');
    models.allowed_models = allowed;
  }
  const configuredModels: Record<string, unknown> = Object.create(null);
  for (const [name, raw] of Object.entries(object(data.model))) configuredModels[name] = copyKeys(object(raw), GROK_MODEL_FIELDS);
  const providers: Record<string, unknown> = Object.create(null);
  for (const [name, raw] of Object.entries(object(data.model_providers))) providers[name] = copyKeys(object(raw), GROK_MODEL_FIELDS);
  return {
    models,
    ...(Object.keys(configuredModels).length ? { model: configuredModels } : {}),
    ...(Object.keys(providers).length ? { model_providers: providers } : {}),
  };
};

const CLAUDE_INFERENCE_ENV: Record<string, true> = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  ANTHROPIC_BASE_URL: true,
  ANTHROPIC_MODEL: true,
  ANTHROPIC_DEFAULT_SONNET_MODEL: true,
  ANTHROPIC_DEFAULT_OPUS_MODEL: true,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: true,
  CLAUDE_CODE_EFFORT_LEVEL: true,
};
const GROK_ENV_AUTH: Record<string, true> = {
  XAI_API_KEY: true,
  OPENAI_API_KEY: true,
  ANTHROPIC_API_KEY: true,
  GROQ_API_KEY: true,
  MISTRAL_API_KEY: true,
  DEEPSEEK_API_KEY: true,
  COHERE_API_KEY: true,
  TOGETHER_API_KEY: true,
  FIREWORKS_API_KEY: true,
  PERPLEXITY_API_KEY: true,
  DEEPINFRA_API_KEY: true,
};

const grokAuthEnvironment = (data: Record<string, unknown>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  const source = processEnv();
  for (const table of [object(data.models), object(data.model), object(data.model_providers)])
    for (const value of Object.values(table)) {
      const envKey = object(value).env_key;
      const envKeys = typeof envKey === 'string' ? [envKey] : Array.isArray(envKey) ? envKey : [];
      for (const key of envKeys) if (typeof key === 'string' && Object.hasOwn(GROK_ENV_AUTH, key) && source[key]) environment[key] = source[key];
    }
  return environment;
};

export const loadNativeModelProfile = async (cli: CliId, privateRoot: string): Promise<NativeModelProfile> => {
  const native = await loadNativeConfig(cli);
  if (native.issues.length) throw new Error(native.issues.join('; '));
  const data = object(native.data);
  if (cli === 'pi') {
    const directory = path.join(privateRoot, 'pi');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify(piProjection(data)), { mode: 0o600 });
    const settings = copyKeys(object(native.auxiliary), ['defaultProvider', 'defaultModel', 'defaultThinkingLevel']);
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  } else if (cli === 'opencode') {
    const directory = path.join(privateRoot, 'opencode', 'config');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'opencode.json'), JSON.stringify(openCodeProjection(data)), { mode: 0o600 });
  } else if (cli === 'grok') {
    const directory = path.join(privateRoot, 'grok');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'config.toml'), stringifyToml(grokProjection(data)), { mode: 0o600 });
  }
  const grokEnvironment = cli === 'grok' ? grokAuthEnvironment(data) : {};
  const claude = cli === 'claude' ? object(data.env) : {};
  const claudeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(claude)) if (CLAUDE_INFERENCE_ENV[key] && typeof value === 'string') claudeEnv[key] = value;
  if (cli === 'claude' && native.defaultThinking && !claudeEnv.CLAUDE_CODE_EFFORT_LEVEL) claudeEnv.CLAUDE_CODE_EFFORT_LEVEL = native.defaultThinking;
  return {
    cli,
    defaultModel: native.defaultModel,
    defaultThinking: native.defaultThinking,
    claudeEnv,
    grokEnvironment,
    grokConfiguredApiKey: hasNativeGrokApiKey(data) || Object.keys(grokEnvironment).length > 0,
  };
};

export const nativeInferenceDefaults = (profile: NativeModelProfile, selectedModel: string, selectedThinking: ThinkingLevel) => ({
  model: selectedModel || profile.defaultModel || '',
  thinking: selectedThinking === 'default' ? (profile.defaultThinking ?? 'default') : selectedThinking,
});

export const nativeClaudeInferenceEnv = (profile: NativeModelProfile, thinking: ThinkingLevel): NodeJS.ProcessEnv => {
  const env = { ...profile.claudeEnv };
  if (thinking !== 'default') delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
};

export const hasNativeGrokApiKey = (data: Record<string, unknown>): boolean => {
  const candidates = [object(data.model), object(data.models), object(data.model_providers)];
  return candidates.some((models) =>
    Object.entries(models).some(
      ([name, value]) => name !== 'default' && name !== 'small' && typeof object(value).api_key === 'string' && Boolean(object(value).api_key),
    ),
  );
};

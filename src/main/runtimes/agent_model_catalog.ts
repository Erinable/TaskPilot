import type * as agentRuntime from '../../shared/agent_runtime.ts';
import { loadNativeConfig } from './cli_native_config.ts';
import type { NativeCliConfig, NativeConfigOptions } from './cli_native_config.ts';
import { isObject } from '../agents/output_validation.ts';
import { CODING_HOME, codingModelConfigReader } from './coding_model_config.ts';
import { CONTROL_CHARS } from '../../shared/text_rules.ts';

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && value.length <= 200 && !CONTROL_CHARS.test(value) && !/[\t\r\n]/.test(value) ? value.trim() : null;
const MAX_MODELS = 2000;
type AppendModel = (id: string | null, label: unknown, provider: string | null, variants: unknown, source: agentRuntime.CliModelOption['source']) => void;

const piModels = (native: NativeCliConfig, append: AppendModel) => {
  const providers = isObject(native.data.providers) ? native.data.providers : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isObject(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isObject(model)) continue;
      const id = clean(model.id);
      const variants = isObject(model.thinkingLevelMap) ? Object.keys(model.thinkingLevelMap) : [];
      append(id ? `${providerId}/${id}` : null, model.name ?? id, providerId, variants, 'config');
    }
  }
};

const openCodeModels = (native: NativeCliConfig, append: AppendModel) => {
  const providers = isObject(native.data.provider) ? native.data.provider : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isObject(provider) || !isObject(provider.models)) continue;
    for (const [id, value] of Object.entries(provider.models)) {
      const model = isObject(value) ? value : {};
      append(`${providerId}/${id}`, model.name ?? id, providerId, isObject(model.variants) ? Object.keys(model.variants) : [], 'config');
    }
  }
};

const grokModels = (native: NativeCliConfig, append: AppendModel) => {
  const declared = isObject(native.data.model) ? native.data.model : {};
  for (const [id, value] of Object.entries(declared)) {
    const model = isObject(value) ? value : {};
    append(clean(id), model.name ?? id, clean(model.model_provider), [], 'config');
  }
};

const codexModels = (native: NativeCliConfig, append: AppendModel) => {
  const provider = clean(native.data.model_provider);
  if (!provider || provider === 'openai') {
    const cached = Array.isArray(native.auxiliary.models) ? native.auxiliary.models : [];
    for (const value of cached) {
      if (!isObject(value) || value.visibility === 'hide') continue;
      const variants = Array.isArray(value.supported_reasoning_levels)
        ? value.supported_reasoning_levels.flatMap((level) => (isObject(level) && clean(level.effort) ? [level.effort] : []))
        : [];
      append(clean(value.slug ?? value.id), value.display_name ?? value.slug, provider, variants, 'cache');
    }
  }
  const profiles = isObject(native.data.profiles) ? native.data.profiles : {};
  for (const value of Object.values(profiles)) {
    if (!isObject(value)) continue;
    append(clean(value.model), value.model, clean(value.model_provider) ?? provider, [], 'config');
  }
};

const claudeModels = (native: NativeCliConfig, append: AppendModel) => {
  const env = isObject(native.data.env) ? native.data.env : {};
  const aliases = [
    ['sonnet', env.ANTHROPIC_DEFAULT_SONNET_MODEL],
    ['opus', env.ANTHROPIC_DEFAULT_OPUS_MODEL],
    ['haiku', env.ANTHROPIC_DEFAULT_HAIKU_MODEL],
  ];
  for (const [alias, target] of aliases) {
    append(String(alias), typeof target === 'string' && target.trim() ? `${alias} · ${target}` : alias, null, [], 'cli');
    append(clean(target), target, null, [], 'config');
  }
};

const metadata = (native: NativeCliConfig): agentRuntime.CliModelOption[] => {
  const models: agentRuntime.CliModelOption[] = [];
  const allowedGrokModels = native.cli === 'grok' && isObject(native.data.models) ? native.data.models.allowed_models : undefined;
  const declaredGrokModels = native.cli === 'grok' && isObject(native.data.model) ? native.data.model : {};
  const allowedPatterns = Array.isArray(allowedGrokModels)
    ? allowedGrokModels.flatMap((value) => {
        const pattern = clean(value);
        if (!pattern) return [];
        const expression = pattern
          .split(/([*?])/)
          .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
          .join('');
        return [new RegExp(`^${expression}$`)];
      })
    : [];
  const append = (id: string | null, label: unknown, provider: string | null, variants: unknown, source: agentRuntime.CliModelOption['source']) => {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$/.test(id) || models.length >= MAX_MODELS) return;
    if (Array.isArray(allowedGrokModels) && allowedGrokModels.length) {
      const declared = declaredGrokModels[id];
      const wireModel = isObject(declared) && typeof declared.model === 'string' ? declared.model : id;
      if (!allowedPatterns.some((pattern) => pattern.test(id) || pattern.test(wireModel))) return;
    }
    const variantNames = Array.isArray(variants) ? variants.flatMap((value) => (clean(value) ? [String(value)] : [])) : [];
    models.push({ id, label: clean(label) ?? id, provider, variants: [...new Set(variantNames)], source });
  };
  switch (native.cli) {
    case 'pi':
      piModels(native, append);
      break;
    case 'opencode':
      openCodeModels(native, append);
      break;
    case 'grok':
      grokModels(native, append);
      break;
    case 'codex':
      codexModels(native, append);
      break;
    default:
      claudeModels(native, append);
  }
  if (native.defaultModel && !models.some((model) => model.id === native.defaultModel)) {
    append(native.defaultModel, native.defaultModel, null, [], 'config');
  }
  return [...new Map(models.map((model) => [model.id, model])).values()];
};

// Never return the native object, provider options, headers, env or auth. Only
// explicitly constructed model metadata crosses the renderer boundary.
export const catalogFromNative = (native: NativeCliConfig, scope: agentRuntime.CliModelScope): agentRuntime.CliModelCatalog => ({
  cli: native.cli,
  scope,
  models: metadata(native),
  defaultModel: native.defaultModel,
  defaultThinking: native.defaultThinking,
  issues: [...native.issues],
});

// separateUser: Coding Agent runs as the dedicated OS user, so its models come
// from that account's config. In sandbox mode it runs the developer's own CLI
// and reads the developer's config, like analysis.
export const readModelCatalog = async (
  cli: agentRuntime.CliId,
  scope: agentRuntime.CliModelScope,
  { separateUser = false, ...options }: NativeConfigOptions & { separateUser?: boolean } = {},
): Promise<agentRuntime.CliModelCatalog> => {
  const source =
    scope === 'coding' && separateUser && !options.home && !options.readObject
      ? { ...options, home: CODING_HOME, environment: {}, readObject: codingModelConfigReader(cli) }
      : options;
  const native = await loadNativeConfig(cli, source);
  const catalog = catalogFromNative(native, scope);
  if (!catalog.models.length && !catalog.issues.length) catalog.issues.push('CLI 本地配置中未声明模型；可以使用 CLI 默认值或填写自定义模型 ID。');
  return catalog;
};

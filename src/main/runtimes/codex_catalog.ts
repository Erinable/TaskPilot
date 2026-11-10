// Codex 0.164.0 has no global switch for apply_patch. An authoritative local
// model catalog removes its tool metadata before Codex builds the registry.
// This is deliberately a new descriptor: never copy model prompts or tool fields
// from an untrusted user/cache catalog into the restricted analysis process.
import fs from 'node:fs/promises';
import path from 'node:path';

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const ANALYSIS_INSTRUCTIONS =
  'You are a restricted analysis assistant. Answer only from the supplied input. Do not use tools, inspect local files, execute commands or contact external services. Return the requested JSON object.';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : null;

export const restrictedCodexCatalog = (model: string, metadata: unknown = {}) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$/.test(model)) throw new Error('Codex restricted analysis requires an explicit valid model ID');
  const source = object(metadata);
  const levels = Array.isArray(source.supported_reasoning_levels) ? source.supported_reasoning_levels : [];
  const supportedReasoningLevels = [
    ...new Set(
      levels.flatMap((entry) => {
        const effort = object(entry).effort;
        return typeof effort === 'string' && (REASONING_LEVELS as readonly string[]).includes(effort) ? [effort] : [];
      }),
    ),
  ].map((effort) => ({ effort, description: effort }));
  const defaultReasoningLevel =
    typeof source.default_reasoning_level === 'string' && supportedReasoningLevels.some((level) => level.effort === source.default_reasoning_level)
      ? source.default_reasoning_level
      : null;
  return {
    models: [
      {
        slug: model,
        display_name: model,
        description: 'TaskPilot restricted structured analysis',
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
        shell_type: 'disabled',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        upgrade: null,
        model_messages: { instructions_template: ANALYSIS_INSTRUCTIONS },
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        supports_reasoning_summary_parameter: source.supports_reasoning_summary_parameter === true,
        default_reasoning_summary: 'none',
        support_verbosity: source.support_verbosity === true,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'bytes', limit: 10_000 },
        supports_image_detail_original: false,
        context_window: positiveInteger(source.context_window),
        max_context_window: positiveInteger(source.max_context_window),
        auto_compact_token_limit: null,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ['text'],
        supports_search_tool: false,
        supports_experimental_context: false,
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: true,
        tool_mode: 'direct',
        multi_agent_version: null,
      },
    ],
  };
};

export const writeCodexCatalog = async (privateRoot: string, model: string, metadata?: unknown): Promise<string> => {
  if (!path.isAbsolute(privateRoot)) throw new Error('Codex private catalog directory must be absolute');
  const catalog = restrictedCodexCatalog(model, metadata);
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const file = path.join(privateRoot, 'taskpilot-model-catalog.json');
  await fs.writeFile(file, `${JSON.stringify(catalog)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
};

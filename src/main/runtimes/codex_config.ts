import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import { AgentRunError } from './claude_cli.ts';

export const CODEX_ANALYSIS_MIN_VERSION = '0.164.0';
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'code_mode',
  'code_mode_host',
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'view_image',
  'image_generation',
  'artifact',
  'tool_suggest',
  'skill_search',
  'skill_mcp_dependency_install',
  'memories',
  'goals',
  'workspace_dependencies',
  'sleep_tool',
  'auth_elicitation',
];

// Feature flags alone do not disable model-declared apply_patch. The caller
// must also supply TaskPilot's model catalog with every tool capability removed.
export const codexAnalysisOverrides = (catalog: string) => [
  ...DISABLED_FEATURES.map((name) => `features.${name}=false`),
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'web_search="disabled"',
  'agents.enabled=false',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'cloud.skills.enabled=false',
  'project_doc_max_bytes=0',
  'mcp_servers={}',
  'apps._default.enabled=false',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'check_for_update_on_startup=false',
  `model_catalog_json=${JSON.stringify(catalog)}`,
];

export const codexAnalysisArgs = (config: AgentRuntimeConfig, paths: { cwd: string; schema: string; instructions: string; catalog: string; model: string }) => {
  const overrides = [
    ...codexAnalysisOverrides(paths.catalog),
    `model_instructions_file=${JSON.stringify(paths.instructions)}`,
    ...(config.thinking === 'default' ? [] : [`model_reasoning_effort=${JSON.stringify(config.thinking)}`]),
  ];
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--cd',
    paths.cwd,
    '--output-schema',
    paths.schema,
    '--model',
    paths.model,
    ...overrides.flatMap((entry) => ['-c', entry]),
    '-',
  ];
};

export const validateCodexAnalysisVersion = (version: string, help: string, features: string) => {
  const match = /codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/i.exec(version);
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) >= 164);
  const flags = ['--json', '--ephemeral', '--ignore-rules', '--strict-config', '--output-schema', '--sandbox'];
  const gates = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins', 'hooks'];
  if (!supported || flags.some((flag) => !help.includes(flag)) || gates.some((name) => !new RegExp(`^${name}\\s+`, 'm').test(features)))
    throw new AgentRunError(
      `Codex 受限分析需要 ${CODEX_ANALYSIS_MIN_VERSION} 或更新的兼容 CLI（支持 JSON Schema、临时会话、严格配置与工具控制）。请更新 Codex 后重新检测。`,
      'agent_unavailable',
    );
};

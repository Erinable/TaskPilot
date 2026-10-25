// Runtime choices are per role, not per repository. Execution identity and paths
// are fixed by TaskPilot; users only choose the CLI, model and thinking level.
export const AGENT_IDS = ['product-lead', 'architect', 'qa', 'release-manager', 'env-steward', 'tutor', 'coding-agent'] as const;
// Every role is a member of the AI team: the sidebar, the team page, the
// activity feed and spend all list these, in this order.
export type AgentId = (typeof AGENT_IDS)[number];
export const CLI_IDS = ['claude', 'pi', 'grok', 'codex', 'opencode'] as const;
export type CliId = (typeof CLI_IDS)[number];
export const THINKING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentRuntimeConfig = { cli: CliId; model: string; thinking: ThinkingLevel };
export type AgentSettings = Record<AgentId, AgentRuntimeConfig>;
export type AgentRuntimeStatus = {
  agent: AgentId;
  config: AgentRuntimeConfig;
  command: string;
  available: boolean;
  version: string | null;
  reason: string | null;
};

export type CliModelScope = 'analysis' | 'coding';
export type CliModelOption = {
  id: string;
  label: string;
  provider: string | null;
  variants: string[];
  source: 'config' | 'cache' | 'cli';
};
export type CliModelCatalog = {
  cli: CliId;
  scope: CliModelScope;
  models: CliModelOption[];
  defaultModel: string | null;
  defaultThinking: ThinkingLevel | null;
  issues: string[];
};
export type CliModelsRequest = { cli: CliId; scope: CliModelScope; refresh?: boolean };
export const AGENT_LABELS: Record<AgentId, string> = {
  'product-lead': 'Product Lead',
  architect: 'Architect',
  qa: 'QA Partner',
  'release-manager': 'Release Manager',
  'env-steward': 'Environment Steward',
  tutor: 'Tutor',
  'coding-agent': 'Coding Agent',
};
export const CLI_OPTIONS: readonly { id: CliId; label: string; analysis: boolean; thinking: readonly ThinkingLevel[]; note: string }[] = [
  { id: 'claude', label: 'Claude Code', analysis: true, thinking: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], note: '' },
  { id: 'pi', label: 'Pi', analysis: true, thinking: THINKING_LEVELS, note: '模型可使用 provider/model；模型须支持所选思考强度。' },
  { id: 'grok', label: 'Grok', analysis: true, thinking: ['default', 'low', 'medium', 'high'], note: '思考强度须由所选模型支持。' },
  {
    id: 'codex',
    label: 'Codex',
    analysis: false,
    thinking: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    note: '仅编码执行：CLI 没有已验证的全工具关闭模式，不能用于受限分析或 QA。',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    analysis: true,
    thinking: THINKING_LEVELS,
    note: '模型使用 provider/model；思考强度映射为模型 variant。受限分析仅支持 OpenCode 1.x。',
  },
];
export const defaultAgentSettings = (): AgentSettings => ({
  'product-lead': { cli: 'claude', model: '', thinking: 'default' },
  architect: { cli: 'claude', model: '', thinking: 'default' },
  qa: { cli: 'claude', model: '', thinking: 'default' },
  'release-manager': { cli: 'claude', model: '', thinking: 'default' },
  'env-steward': { cli: 'claude', model: '', thinking: 'default' },
  tutor: { cli: 'claude', model: '', thinking: 'default' },
  'coding-agent': { cli: 'codex', model: '', thinking: 'default' },
});
export const supportsAgentConfig = (agent: AgentId, config: AgentRuntimeConfig): boolean => {
  const option = CLI_OPTIONS.find((entry) => entry.id === config.cli);
  return Boolean(option && (agent === 'coding-agent' || option.analysis) && option.thinking.includes(config.thinking));
};

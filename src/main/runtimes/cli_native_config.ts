// Native CLI config stays in the main process. Catalog IPC receives a separate
// metadata projection; connection settings and credentials never cross it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';

import { processEnv } from '../infrastructure/env.ts';
import type { CliId, ThinkingLevel } from '../../shared/agent_runtime.ts';
import { isObject } from '../agents/output_validation.ts';

export type NativeCliConfig = {
  cli: CliId;
  files: string[];
  data: Record<string, unknown>;
  auxiliary: Record<string, unknown>;
  defaultModel: string | null;
  defaultThinking: ThinkingLevel | null;
  issues: string[];
};
export type NativeObjectResult = { data: Record<string, unknown>; found: boolean; issue: string | null };
export type NativeConfigOptions = {
  home?: string;
  environment?: NodeJS.ProcessEnv;
  readObject?: (file: string, format: 'json' | 'toml') => Promise<NativeObjectResult>;
};
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const thinking = (value: unknown): ThinkingLevel | null =>
  typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? (value as ThinkingLevel) : null;

const mergeConfig = (lower: Record<string, unknown>, higher: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    const previous = Object.hasOwn(lower, key) ? lower[key] : undefined;
    const combined = isObject(previous) && isObject(value) && !Array.isArray(previous) && !Array.isArray(value) ? mergeConfig(previous, value) : value;
    Object.defineProperty(merged, key, { value: combined, enumerable: true, configurable: true, writable: true });
  }
  return merged;
};

// Parse errors may include a config source line containing a credential. Only
// paths and generic problems are reported; parser messages are never returned.
export const parseNativeContent = (content: string, file: string, format: 'json' | 'toml'): NativeObjectResult => {
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) return { data: {}, found: true, issue: `CLI 配置超过 4 MiB：${file}` };
  try {
    let value: unknown;
    if (format === 'toml') value = parseToml(content);
    else {
      const errors: ParseError[] = [];
      value = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length) return { data: {}, found: true, issue: `CLI 配置 JSON 无效：${file}` };
    }
    if (!isObject(value) || Array.isArray(value)) return { data: {}, found: true, issue: `CLI 配置必须是对象：${file}` };
    return { data: value, found: true, issue: null };
  } catch {
    return { data: {}, found: true, issue: `CLI 配置 ${format.toUpperCase()} 无效：${file}` };
  }
};

export const readNativeObject = async (file: string, format: 'json' | 'toml'): Promise<NativeObjectResult> => {
  let content: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return { data: {}, found: true, issue: `CLI 配置不是普通文件或超过 4 MiB：${file}` };
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { data: {}, found: false, issue: null };
    return { data: {}, found: true, issue: `无法读取 CLI 配置：${file}` };
  }
  return parseNativeContent(content, file, format);
};

const nativeConfigRoot = (cli: CliId, home: string, environment: NodeJS.ProcessEnv, useEnvironmentPaths: boolean) => {
  const roots = {
    pi: ['PI_CODING_AGENT_DIR', '.pi/agent'],
    opencode: ['OPENCODE_CONFIG_DIR', '.config/opencode'],
    grok: ['GROK_HOME', '.grok'],
    codex: ['CODEX_HOME', '.codex'],
    claude: ['CLAUDE_CONFIG_DIR', '.claude'],
  } as const;
  const [variable, relative] = roots[cli];
  if (useEnvironmentPaths && environment[variable]) return environment[variable]!;
  if (cli === 'opencode' && useEnvironmentPaths && environment.XDG_CONFIG_HOME) return path.join(environment.XDG_CONFIG_HOME, 'opencode');
  return path.join(home, relative);
};

export const loadNativeConfig = async (cli: CliId, options: NativeConfigOptions = {}): Promise<NativeCliConfig> => {
  const environment = options.environment ?? processEnv();
  const home = options.home ?? environment.HOME ?? os.homedir();
  const useEnvironmentPaths = !options.home;
  const root = nativeConfigRoot(cli, home, environment, useEnvironmentPaths);
  const files: string[] = [];
  const issues: string[] = [];
  const load = async (file: string, format: 'json' | 'toml') => {
    const result = await (options.readObject ?? readNativeObject)(file, format);
    if (result.found) files.push(file);
    if (result.issue) issues.push(result.issue);
    return result.data;
  };
  let data: Record<string, unknown> = {};
  let auxiliary: Record<string, unknown> = {};
  let defaultModel: string | null = null;
  let defaultThinking: ThinkingLevel | null = null;
  if (cli === 'pi') {
    data = await load(path.join(root, 'models.json'), 'json');
    auxiliary = await load(path.join(root, 'settings.json'), 'json');
    const provider = text(auxiliary.defaultProvider);
    const model = text(auxiliary.defaultModel);
    defaultModel = provider && model ? `${provider}/${model}` : model;
    defaultThinking = thinking(auxiliary.defaultThinkingLevel ?? auxiliary.thinkingLevel);
  } else if (cli === 'opencode') {
    const json = await load(path.join(root, 'opencode.json'), 'json');
    const jsonc = await load(path.join(root, 'opencode.jsonc'), 'json');
    data = mergeConfig(json, jsonc);
    if (useEnvironmentPaths && environment.OPENCODE_CONFIG) data = mergeConfig(data, await load(environment.OPENCODE_CONFIG, 'json'));
    defaultModel = text(data.model);
  } else if (cli === 'grok') {
    const managed = await load(path.join(root, 'managed_config.toml'), 'toml');
    const local = await load(path.join(root, 'config.toml'), 'toml');
    data = mergeConfig(managed, local);
    const models = isObject(data.models) ? data.models : {};
    defaultModel = text(models.default);
    defaultThinking = thinking(models.default_reasoning_effort);
  } else if (cli === 'codex') {
    data = await load(path.join(root, 'config.toml'), 'toml');
    auxiliary = await load(path.join(root, 'models_cache.json'), 'json');
    defaultModel = text(data.model);
    defaultThinking = thinking(data.model_reasoning_effort);
  } else {
    data = await load(path.join(root, 'settings.json'), 'json');
    const env = isObject(data.env) ? data.env : {};
    defaultModel = text(environment.ANTHROPIC_MODEL) ?? text(data.model) ?? text(env.ANTHROPIC_MODEL);
    defaultThinking = thinking(environment.CLAUDE_CODE_EFFORT_LEVEL ?? data.effortLevel);
  }
  return { cli, files, data, auxiliary, defaultModel, defaultThinking, issues: [...new Set(issues)] };
};

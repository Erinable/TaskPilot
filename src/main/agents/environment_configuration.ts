// The Environment Steward's proposed infrastructure work. It is data for a
// normal work package, never a command or a patch applied by environment setup.
import { AgentOutputError, isObject } from './output_validation.ts';
import type { SetupAdapter } from '../checking/setup_adapter.ts';
import type { EnvConfiguration } from '../../shared/ipc/environment.ts';

export type ConfigurationPolicy = Pick<SetupAdapter, 'stepKinds' | 'configurationFiles' | 'commandFor'>;

const stringSchema = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const stringsSchema = (maxItems: number, maxLength: number) => ({ type: 'array', minItems: 1, maxItems, items: stringSchema(maxLength) });

export const configurationSchema = (setup: Pick<ConfigurationPolicy, 'stepKinds' | 'configurationFiles'>) => ({
  // Strict structured output accepts anyOf, but rejects oneOf. The null
  // and object branches are disjoint, so this keeps the same validation.
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'reason', 'checks', 'fileScope', 'steps', 'acceptance'],
      properties: {
        title: stringSchema(60),
        reason: stringSchema(400),
        checks: {
          type: 'array',
          maxItems: setup.stepKinds.length,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'script', 'reason'],
            properties: { kind: { type: 'string', enum: [...setup.stepKinds] }, script: stringSchema(64), reason: stringSchema(200) },
          },
        },
        fileScope: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', enum: [...setup.configurationFiles] } },
        steps: stringsSchema(12, 600),
        acceptance: stringsSchema(10, 400),
      },
    },
  ],
});

const invalid = (field: string): never => {
  throw new AgentOutputError(`configuration.${field} is invalid`);
};

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) return invalid(field);
  return value.trim();
};

const texts = (value: unknown, field: string, count: number, max: number): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > count) return invalid(field);
  return value.map((entry) => text(entry, field, max));
};

export const validateConfiguration = (raw: unknown, setup: ConfigurationPolicy): EnvConfiguration | null => {
  if (raw === null) return null;
  if (!isObject(raw)) return invalid('proposal');
  const fileScope = [...new Set(texts(raw.fileScope, 'fileScope', 30, 200))];
  if (fileScope.some((file) => !setup.configurationFiles.includes(file))) return invalid('fileScope');
  if (!Array.isArray(raw.checks) || raw.checks.length > setup.stepKinds.length) return invalid('checks');
  const checks = raw.checks.map((entry): EnvConfiguration['checks'][number] => {
    if (!isObject(entry) || !setup.stepKinds.includes(entry.kind as EnvConfiguration['checks'][number]['kind'])) return invalid('checks.kind');
    const kind = entry.kind as EnvConfiguration['checks'][number]['kind'];
    const script = text(entry.script, 'checks.script', 64);
    // The adapter validates script-name syntax. This command is never run here.
    try {
      setup.commandFor(kind, script);
    } catch {
      return invalid('checks.script');
    }
    return { kind, script, reason: text(entry.reason, 'checks.reason', 200) };
  });
  if (new Set(checks.map((check) => check.kind)).size !== checks.length) return invalid('checks.kind');
  if (checks.length && (!fileScope.includes('package.json') || !fileScope.includes('taskpilot.toml'))) return invalid('fileScope');
  return {
    title: text(raw.title, 'title', 60),
    reason: text(raw.reason, 'reason', 400),
    checks,
    fileScope,
    steps: texts(raw.steps, 'steps', 12, 600),
    acceptance: texts(raw.acceptance, 'acceptance', 10, 400),
  };
};

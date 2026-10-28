// The settings form for check steps, and its inverse. The form sends typed
// command lines; they are tokenized here (no shell), and every field goes
// through the same validators as workspace.json and taskpilot.toml.
import { isStepId } from '../../shared/check_steps.ts';
import { formatCommandLine } from './command_line.ts';
import * as stepConfig from './step_config.ts';
import type { StepId } from '../../shared/check_steps.ts';
import type { StoredStep } from './step_config.ts';
import type { WorkspaceConfig } from '../repository/workspace.ts';
import type { ResolvedStep, Resolution } from './effective_steps.ts';
import type * as workspaceTypes from '../../shared/ipc/workspace.ts';
import type { LooseJson } from '../infrastructure/loose_json.ts';

const toSeconds = (timeoutMs: number | undefined) => (timeoutMs === undefined ? null : Math.round(timeoutMs / 1000));

export const toStepForm = (step: StoredStep): workspaceTypes.StepForm => ({
  enabled: step.enabled,
  lines: step.commands.map(formatCommandLine),
  cwd: step.cwd,
  stage: step.stage,
  blocking: step.blocking,
  parser: step.parser,
  timeoutSeconds: toSeconds(step.timeoutMs),
});

// One form step as workspace.json stores it, or null when it sets nothing
// (no command lines and not turned off). Errors name `steps.<id>.<field>`.
const fromStepForm = (value: unknown, id: StepId, kept: StoredStep | undefined): StoredStep | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as LooseJson;
  const lines = Array.isArray(raw.lines) ? raw.lines.filter((line: unknown) => typeof line !== 'string' || line.trim()) : raw.lines;
  const enabled = raw.enabled !== false;
  if (enabled && Array.isArray(lines) && !lines.length) return null;
  return stepConfig.normalizeStoredStep(
    {
      enabled,
      commands: enabled ? lines : [],
      cwd: raw.cwd,
      stage: raw.stage,
      blocking: raw.blocking,
      parser: raw.parser,
      // Variables are not on the form; they are kept from the saved step.
      env: kept?.env,
      timeoutMs: typeof raw.timeoutSeconds === 'number' ? raw.timeoutSeconds * 1000 : raw.timeoutSeconds === null ? undefined : raw.timeoutSeconds,
    },
    id,
    `steps.${id}`,
  );
};

// The renderer's form (untrusted) as a config.
export const fromForm = (form: unknown, previous: WorkspaceConfig): WorkspaceConfig => {
  const raw = (form && typeof form === 'object' ? form : {}) as LooseJson;
  const steps: WorkspaceConfig['steps'] = {};
  const entries = raw.steps && typeof raw.steps === 'object' ? Object.entries(raw.steps as LooseJson) : [];
  for (const [id, value] of entries) {
    if (!isStepId(id)) stepConfig.stepError(`steps.${id}`, 'is not a check step');
    const step = fromStepForm(value, id as StepId, previous.steps[id as StepId]);
    if (step) steps[id as StepId] = step;
  }
  return { ...previous, steps };
};

const effectiveView = (entry: ResolvedStep): workspaceTypes.StepView['effective'] =>
  entry.step && {
    lines: entry.step.commands.map(formatCommandLine),
    cwd: entry.step.cwd,
    stage: entry.step.stage,
    blocking: entry.step.blocking,
    parser: entry.step.parser,
    timeoutSeconds: toSeconds(entry.step.timeoutMs),
  };

export const stepViews = (config: WorkspaceConfig, resolution: Resolution): workspaceTypes.StepView[] =>
  resolution.steps.map((entry) => {
    const local = config.steps[entry.id];
    return {
      id: entry.id,
      label: entry.step?.label ?? null,
      effective: effectiveView(entry),
      source: entry.source,
      skipped: entry.skipped,
      local: local ? toStepForm(local) : null,
      suggestions: resolution.suggestions[entry.id] ?? [],
    };
  });

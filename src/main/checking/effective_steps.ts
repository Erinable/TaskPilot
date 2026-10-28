// The steps a repository actually runs, merged field by field from three
// layers, lowest first:
//   preset   the defaults of the preset taskpilot.toml names
//   project  taskpilot.toml's [steps.*] and [custom.*]
//   local    this machine's settings (workspace.json)
// A higher layer overrides only the fields it sets; `enabled = false` at any
// layer turns the step off (a higher layer can turn it back on). A step no
// layer gives commands is skipped, and listed as skipped.
//
// Without taskpilot.toml there is no preset, so only the local steps run:
// exactly how TaskPilot behaved before presets existed.
import { indexEntries } from '../repository/repo_reader.ts';
import { orderSteps } from '../../shared/check_steps.ts';
import { defaultsFor } from './step_config.ts';
import { WorkspaceError } from './command_line.ts';
import * as projectConfig from '../repository/project_config.ts';
import * as presets from './presets/index.ts';
import type { ErrorCode } from '../../shared/error_codes.ts';
import type { CheckStep, StepPatch } from './step_config.ts';
import type { WorkspaceConfig } from '../repository/workspace.ts';
import type { Detection } from './presets/index.ts';
import type { StepId } from '../../shared/check_steps.ts';
import type { StepSource } from '../../shared/check_steps.ts';

// One step and where its fields came from. `source` is the highest layer
// that set anything; `step` is null when the step does not run.
export type ResolvedStep = {
  id: StepId;
  step: CheckStep | null;
  source: StepSource | null;
  // Why the step does not run.
  skipped: 'disabled' | 'not_configured' | null;
};

// taskpilot.toml as the settings page shows it.
export type ProjectState =
  { status: 'missing' } | { status: 'invalid'; error: { code: ErrorCode; message: string; field: string | null } } | { status: 'ok'; preset: string | null };

export type Resolution = {
  steps: ResolvedStep[];
  project: ProjectState;
  // Recognised languages, for recommending a preset when there is no file.
  detected: Detection[];
  // Command lines to offer per step, from the preset (or the detected one).
  suggestions: Partial<Record<StepId, string[]>>;
};

type Layer = { source: StepSource; steps: Partial<Record<StepId, StepPatch>> };

// Merges one step's patches, lowest layer first.
export const mergeStep = (id: StepId, layers: Layer[]): ResolvedStep => {
  const defaults = defaultsFor(id);
  let merged: StepPatch = {};
  let source: StepSource | null = null;
  for (const layer of layers) {
    const patch = layer.steps[id];
    if (!patch) continue;
    source = layer.source;
    merged = { ...merged, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  }
  if (merged.enabled === false) return { id, step: null, source, skipped: 'disabled' };
  if (!merged.commands?.length) return { id, step: null, source, skipped: 'not_configured' };
  const step: CheckStep = {
    id,
    label: merged.label ?? null,
    commands: merged.commands,
    cwd: merged.cwd ?? '',
    stage: merged.stage ?? defaults.stage,
    blocking: merged.blocking ?? defaults.blocking,
    parser: merged.parser ?? { format: 'tests' },
    env: merged.env ?? {},
  };
  if (merged.timeoutMs !== undefined) step.timeoutMs = merged.timeoutMs;
  return { id, step, source, skipped: null };
};

// Resolves every step from the given layers.
export const mergeSteps = (layers: Layer[], always: Iterable<StepId>): ResolvedStep[] => {
  const ids = orderSteps([...always, ...layers.flatMap((layer) => Object.keys(layer.steps))]);
  return ids.map((id) => mergeStep(id, layers));
};

const projectError = (error: unknown) => {
  if (!(error instanceof WorkspaceError)) throw error;
  return { code: error.code, message: error.message, field: error.field ?? null };
};

// Every step of `config`'s repository. A broken taskpilot.toml is reported,
// and its layer is left out, so local settings still run. `envPath` is the
// PATH steps run with, where a preset looks for optional tools.
export const resolve = async (config: WorkspaceConfig, { always = [] as readonly StepId[], envPath = null as string | null } = {}): Promise<Resolution> => {
  const local: Layer = { source: 'local', steps: config.steps };
  if (!config.root) return { steps: mergeSteps([local], always), project: { status: 'missing' }, detected: [], suggestions: {} };
  const root = config.root;
  const tracked = new Set((await indexEntries(root).catch(() => new Map())).keys());
  const detected = presets.detectLanguages(tracked);

  let project: ProjectState = { status: 'missing' };
  let file: projectConfig.ProjectFile | null = null;
  try {
    const text = await projectConfig.readProjectText(root);
    if (text !== null) {
      file = projectConfig.parseProject(text, presets.PRESET_IDS);
      project = { status: 'ok', preset: file.preset };
    }
  } catch (error) {
    project = { status: 'invalid', error: projectError(error) };
  }

  const preset = presets.presetById(file?.preset ?? null);
  const suggestionSource = preset ?? presets.presetById(detected.find((entry) => entry.preset)?.preset ?? null);
  const suggestionFacts = suggestionSource ? await suggestionSource.facts(root, { envPath }) : null;
  const layers: Layer[] = [];
  if (preset) layers.push({ source: 'preset', steps: preset.steps(suggestionFacts) });
  if (file) layers.push({ source: 'project', steps: file.steps });
  layers.push(local);
  return {
    steps: mergeSteps(layers, always),
    project,
    detected,
    suggestions: suggestionSource ? suggestionSource.suggestions(suggestionFacts) : {},
  };
};

// Only the steps that run.
export const runnable = (resolution: Pick<Resolution, 'steps'>): CheckStep[] => resolution.steps.flatMap((entry) => (entry.step ? [entry.step] : []));

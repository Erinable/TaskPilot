// What the Environment Steward needs from a language to plan its setup: how
// to probe the toolchain, how the facts read in a prompt, which choices a
// plan may make, and the commands those choices become. A preset provides
// one (../presets/preset.ts `setup`); the agents only receive it, so they
// never know a language or a manifest.
//
// SECURITY: a plan only ever picks from installModes and names a script per
// step kind. validate() drops what the facts do not define, and commandFor()
// / buildSteps() build argument arrays themselves; nothing the model writes
// becomes a command line.
import type { CommandEntry } from './command_line.ts';
import type { StepKind } from '../../shared/check_steps.ts';
import type * as envTypes from '../../shared/ipc/environment.ts';

// Corrections TaskPilot made to the steward's choices.
export type EnvAdjustment = envTypes.EnvAdjustment;

// The steward's choices once validate() checked them against the facts.
export type SetupChoice = {
  install: string;
  scripts: Partial<Record<StepKind, string | null>>;
};

// One runnable setup step. `replacesInstall` asks before running a step that
// deletes an existing install; `packages` lists what a rebuild step runs.
export type SetupStep = CommandEntry & {
  id: envTypes.EnvStepId;
  kind: envTypes.EnvStepId;
  script: string | null;
  packages: string[];
  replacesInstall: boolean;
};

// A fenced block of facts for the user prompt: `<tag>body</tag>`.
export type FactSection = { tag: string; body: string };

export interface SetupAdapter<Facts = unknown> {
  probe: (root: string, options: { envPath?: string | null }) => Promise<Facts>;
  // Problems found without a model; some stop planning, some only stop steps.
  blockers: (facts: Facts) => envTypes.EnvBlocker[];
  stopsPlanning: (blockers: readonly envTypes.EnvBlocker[]) => boolean;
  // The blockers that keep `kind` from running.
  blocking: (blockers: readonly envTypes.EnvBlocker[], kind: envTypes.EnvStepId) => envTypes.EnvBlocker[];
  // How the facts and the choices read for this language, and the facts.
  prompt: (facts: Facts) => { rules: string[]; sections: FactSection[] };
  // Install modes the plan may pick, 'skip' included.
  installModes: readonly string[];
  // Step kinds the plan names a script for, a subset of STEP_KINDS.
  stepKinds: readonly StepKind[];
  // Takes the plan's install mode (already one of installModes) and trimmed
  // script names per step kind; corrects what the facts contradict.
  validate: (raw: { install: string; scripts: Partial<Record<StepKind, string>> }, facts: Facts) => SetupChoice & { adjustments: EnvAdjustment[] };
  // The command a step kind's chosen script runs as; throws on an unknown
  // kind or script name.
  commandFor: (kind: StepKind, choice: string) => CommandEntry;
  buildSteps: (choice: SetupChoice, facts: Facts, options: { allowScripts: boolean }) => SetupStep[];
  // The facts as the setup page shows them (shaped as the npm adapter's,
  // the only one there is so far).
  view: (facts: Facts) => envTypes.EnvFacts;
}

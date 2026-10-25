// What a language preset provides: how to recognise the language, the
// default steps for a repository and how their output is read, and the tools
// it needs. A preset only applies when taskpilot.toml names it.
import type { StepId, StepKind } from '../../shared/check_steps.ts';
import type { StepPatch } from '../step_config.ts';

// A tool a preset needs. TaskPilot only checks for it and shows `install`;
// it never installs anything.
export type ToolRequirement = { command: string; versionArgs: string[]; install: string };

export interface Preset<Facts = unknown> {
  id: string;
  label: string;
  // Tracked files that mark the language, for recommending this preset.
  manifests: string[];
  detect: (tracked: ReadonlySet<string>) => boolean;
  // What the defaults depend on, read from the repository's tracked files
  // and, for optional tools, the PATH commands run with.
  facts: (root: string, options?: { envPath?: string | null }) => Promise<Facts>;
  // Default steps, each with its parser.
  steps: (facts: Facts) => Partial<Record<StepId, StepPatch>>;
  // Common command lines per step, offered as choices in settings.
  suggestions: (facts: Facts) => Partial<Record<StepKind, string[]>>;
  tools: ToolRequirement[];
}

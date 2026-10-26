// What a language preset provides: how to recognise the language, the
// default steps for a repository and how their output is read, and the tools
// it needs. A preset only applies when taskpilot.toml names it.
import type { StepId, StepKind } from '../../shared/check_steps.ts';
import type { StepPatch } from '../step_config.ts';
import type { SetupAdapter } from '../setup_adapter.ts';

// A tool a preset needs. TaskPilot only checks for it and shows `install`;
// it never installs anything.
export type CommittedVersion = { file: string; value: string | null };

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
  // [人工决策-2026-10-25 23:51:35] 测试名保持精确匹配（evidence.ts criteriaStatus），只在 prompt 里注入名字格式（CARM-16 决策 A）。
  // How a test's name reads in the results this preset's test step parses
  // (check_output.ts, test_report.ts), the form a linked test is written in.
  testNameFormat: string;
  // Paths, relative to the repository, a Coding Agent patch only changes
  // after the developer confirms (manifests, lockfiles, build scripts), and
  // paths it never changes (credentials). Added to the fixed rules in
  // ../coding_workspace.ts, which they only tighten.
  protectedFiles: RegExp[];
  secretFiles: RegExp[];
  // Where the language's caches go in a sandbox run: under `agentHome`, the
  // run's own home. `home` is the real home.
  sandboxEnv: (agentHome: string, home: string) => Record<string, string>;
  // Folders under the real home the sandbox may read for the toolchain,
  // besides those on PATH.
  sandboxRead: (home: string) => string[];
  // The version committed at `commit` and the file it is read from; value
  // is null when the file is missing, unparsable or not semver. The working
  // tree is never read.
  version: (root: string, commit: string) => Promise<CommittedVersion>;
  // How the Environment Steward plans setup for this language; without one
  // the setup page says automatic planning is not supported yet.
  setup?: SetupAdapter;
}

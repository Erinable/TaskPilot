// Verification checks and their evidence, the diff against the baseline, and the
// workspace configuration (workspace:*, diff:*, verify:run).

import type { ErrorInfo } from './envelope.ts';
import type { CheckParser, Diagnostic, StepId, StepSource } from '../check_steps.ts';
import type { CoursePack, CourseRef, CourseSource } from '../course_pack.ts';

// `test` links a criterion to a test name; without it the criterion is manual.
export type AcceptanceCriterion = { text: string; test?: string };
// ========== checks and evidence ==========

// A check step: one of the fixed steps or a project's custom step.
export type CheckKind = StepId;
export type CheckStage = 'step' | 'submit';

// One parsed test result; `fullName` is the key baselines compare by.
export type TestResult = { name: string; fullName?: string; passed: boolean; skipped: boolean; todo: boolean };

export type RunSummary = { total: number; passed: number; failed: number; skipped: number; ok: boolean };

export type ReportProblem = 'missing' | 'stale' | 'not_a_file' | 'outside' | 'too_large' | 'invalid';

// Whether the output could be read in the step's parser format.
export type ReportInfo = { format: string; trusted: boolean; problem: ReportProblem | null };

// verification.runStep(): one run of a check step.
export type CheckRun = {
  kind: CheckKind;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string;
  results: TestResult[];
  // Every finding as file / line / severity / message, whatever the tool.
  diagnostics: Diagnostic[];
  summary: RunSummary;
  report: ReportInfo;
  check: { stage: CheckStage; blocking: boolean };
};

// What a stored review keeps of a run (qa.compactRun()).
export type CompactRun =
  | { error: ErrorInfo }
  | {
      kind: CheckKind;
      command: string;
      exitCode: number;
      timedOut: boolean;
      durationMs: number;
      summary: RunSummary;
      report: ReportInfo | null;
      failing: string[];
      outputTail: string | null;
    };

export type EvidenceStatus = 'pass' | 'fail' | 'unverifiable' | 'skipped';

// Reason codes are open-ended (report_<problem>, error codes), so plain strings.
export type Evidence = {
  kind: CheckKind;
  stage: CheckStage;
  blocking: boolean;
  baseline: 'measured' | 'none';
  status: EvidenceStatus;
  reason: string | null;
  newFailures: string[];
  preexisting: string[];
  fixed: string[];
};

export type CriterionStatus = 'verified' | 'failed' | 'missing' | 'unverifiable' | 'manual';

// evidence.criteriaStatus(); verified/manual/missing are the legacy flags.
export type CriterionEvidence = AcceptanceCriterion & {
  status: CriterionStatus;
  verified: boolean;
  manual: boolean;
  missing?: boolean;
  alreadyPassing?: boolean;
};

export type AttentionItem =
  | { code: 'check_unverifiable'; kind: CheckKind; reason: string | null; blocking: boolean }
  | { code: 'preexisting_failures'; kind: CheckKind; count: number }
  | { code: 'no_baseline'; kind: CheckKind }
  | { code: 'criterion_unverifiable' | 'criterion_manual' | 'criterion_already_passing'; index: number };

// evidence.baselineRecord(), or why a check has none.
export type BaselineCheckRecord =
  | {
      status: 'measured';
      line: string;
      exitCode: number;
      timedOut: boolean;
      crashed: boolean;
      reportProblem: ReportProblem | null;
      failing: string[];
      passing: string[];
      at: string;
    }
  | { status: 'unavailable'; reason: string; line: string };

export type BaselineStatus = 'measuring' | 'measured' | 'unavailable' | 'contaminated';

// Reasons: no_checks | head_moved | dirty_tree | cancelled | interrupted |
// tree_changed, or an error code.
export type BaselineChecks = {
  status: BaselineStatus;
  reason: string | null;
  commit: string;
  checks: Partial<Record<CheckKind, BaselineCheckRecord>>;
  startedAt: string;
  finishedAt: string | null;
};

// verify:run with a task id adds the same comparison a review makes.
export type VerifyRun = CheckRun & { evidence?: Evidence; acceptance?: CriterionEvidence[] };
// ========== diff ==========

export type FileChange = { path: string; added: number; removed: number; binary: boolean; untracked: boolean };

export type FileScopeCheck = { inScope: string[]; outOfScope: string[]; untouched: string[] };

export type DiffStat = { changes: FileChange[]; scope: FileScopeCheck };

// A unified diff for one file.
export type DiffFile = string;

// ========== workspace ==========

export type CommandEntry = { command: string; args: string[] };

// One step as the settings page edits it. `lines` are the command lines
// this machine sets ('' or [] leaves the step to taskpilot.toml or the
// preset); `enabled: false` turns it off here.
export type StepForm = {
  enabled: boolean;
  lines: string[];
  cwd: string;
  stage: CheckStage;
  blocking: boolean;
  parser: CheckParser;
  timeoutSeconds: number | null;
};

// What the settings page sends to workspace:set and workspace:check. A step
// left out keeps nothing on this machine.
export type WorkspaceForm = {
  root: string;
  steps: Partial<Record<StepId, StepForm>>;
};

// One step as it will run: merged from the preset, taskpilot.toml and this
// machine. `local` is what this machine sets, null when nothing.
export type StepView = {
  id: StepId;
  label: string | null;
  // Null when the step does not run; `skipped` then says why.
  effective: { lines: string[]; cwd: string; stage: CheckStage; blocking: boolean; parser: CheckParser; timeoutSeconds: number | null } | null;
  source: StepSource | null;
  skipped: 'disabled' | 'not_configured' | null;
  local: StepForm | null;
  suggestions: string[];
};

// taskpilot.toml as found in the repository root.
export type ProjectFileState =
  { status: 'missing' } | { status: 'invalid'; error: { code: string; message: string; field: string | null } } | { status: 'ok'; preset: string | null };

// How the repository's course pack choice resolved. `pending` is a
// repository pack this machine has not confirmed (or that changed since):
// `pack` is shown for the user to confirm, and the built-in programming
// pack is used until then. `invalid` also falls back to programming.
export type CourseState =
  | { status: 'ok' }
  | { status: 'pending'; pack: CoursePack; ref: CourseRef }
  | { status: 'invalid'; error: { code: string; message: string; field: string | null } };

export type CourseView = {
  // The id asked for and who asked: this machine, taskpilot.toml, or nobody.
  selected: { id: string; from: 'local' | 'project' | 'default' };
  available: { id: string; source: CourseSource }[];
  state: CourseState;
  // The pack in use.
  ref: CourseRef;
};

// A recognised language; `preset` is null when TaskPilot has none for it yet.
export type DetectedLanguage = { manifest: string; language: string; preset: string | null };

export type PresetInfo = { id: string; label: string };

// A tool the preset needs, found on PATH or not, with how to install it.
export type ToolStatus = { command: string; version: string | null; install: string };

export type WorkspaceView = {
  root: string | null;
  steps: StepView[];
  project: ProjectFileState;
  course: CourseView;
  detected: DetectedLanguage[];
  presets: PresetInfo[];
};

export type RepoInfo = { commit: string; branch: string | null; dirty: boolean; changedFiles: number };

// workspace:check: validation plus a PATH lookup per step's first command,
// nothing written.
export type WorkspaceCheck = {
  root: string | null;
  repo: RepoInfo | null;
  steps: Partial<Record<StepId, { configured: boolean; resolved: string | null }>>;
  tools: ToolStatus[];
};

export type WorkspaceInfo = { configured: false } | ({ configured: true; root: string } & RepoInfo);

// workspace:open-file: where the file ended up. 'folder' means no editor was
// found and the file was shown in the file manager instead.
export type OpenedWith = 'vscode' | 'text_editor' | 'folder';

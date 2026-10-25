// Verification checks and their evidence, the diff against the baseline, and the
// workspace configuration (workspace:*, diff:*, verify:run).

import type { ErrorInfo } from './envelope.ts';

// `test` links a criterion to a test name; without it the criterion is manual.
export type AcceptanceCriterion = { text: string; test?: string };
// ========== checks and evidence ==========

export type CheckKind = 'test' | 'lint' | 'build' | 'smoke';
export type CheckStage = 'step' | 'submit';

// One parsed test result; `fullName` is the key baselines compare by.
export type TestResult = { name: string; fullName?: string; passed: boolean; skipped: boolean; todo: boolean };

export type RunSummary = { total: number; passed: number; failed: number; skipped: number; ok: boolean };

export type ReportProblem = 'missing' | 'stale' | 'not_a_file' | 'outside' | 'too_large' | 'invalid';

export type ReportInfo = { format: 'stdout' | 'junit'; trusted: boolean; problem: ReportProblem | null };

// verification.runCheck(): one run of a configured check.
export type CheckRun = {
  kind: CheckKind;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string;
  results: TestResult[];
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

export type CheckReport = { format: 'stdout' } | { format: 'junit'; path: string };

export type WorkspaceCheckConfig = CommandEntry & {
  stage: CheckStage;
  blocking: boolean;
  report: CheckReport;
  env: Record<string, string>;
  timeoutMs?: number;
};

// Per-kind options the settings form edits; reportPath '' means stdout.
export type CheckOptions = { stage: CheckStage; blocking: boolean; reportPath: string };

// What the settings page sends to workspace:set and workspace:check. A blank
// command line means the kind is not configured.
export type WorkspaceForm = {
  root: string;
  commands: Partial<Record<CheckKind, string>>;
  options?: Partial<Record<CheckKind, Partial<CheckOptions>>>;
};

// The config plus the command lines and options the form edits.
export type WorkspaceView = {
  root: string | null;
  commands: Record<CheckKind, CommandEntry | null>;
  checks: Record<CheckKind, WorkspaceCheckConfig | null>;
  lines: Record<CheckKind, string>;
  options: Record<CheckKind, CheckOptions>;
};

export type RepoInfo = { commit: string; branch: string | null; dirty: boolean; changedFiles: number };

// workspace:check: validation plus a PATH lookup, nothing written.
export type WorkspaceCheck = {
  root: string | null;
  repo: RepoInfo | null;
  commands: Record<CheckKind, { configured: boolean; resolved: string | null }>;
};

export type WorkspaceInfo = { configured: false } | ({ configured: true; root: string } & RepoInfo);

// workspace:open-file: where the file ended up. 'folder' means no editor was
// found and the file was shown in the file manager instead.
export type OpenedWith = 'vscode' | 'text_editor' | 'folder';

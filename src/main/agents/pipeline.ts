// Runs Architect's two steps (select files, summarize) for a requirement,
// QA's review of a submitted work package, and Architect's ruling on a
// reported deviation.
//
// Shared by the app (ipc.ts) and the eval harness, so both exercise the same
// code path. Failure here is never fatal to the requirement: Product Lead
// can still plan from the file list, so callers get { summary: null, error }.
import * as architect from './architect.ts';
import * as qa from './qa.ts';
import * as envSteward from './env_steward.ts';
import * as releaseManager from './release_manager.ts';
import * as git from '../git.ts';
import { looksSecret } from '../repo_reader.ts';
import * as envSetup from '../presets/typescript_setup.ts';
import { readTracked } from '../repo_reader.ts';
import { collectChanges } from '../review_diff.ts';
import * as evidence from '../evidence.ts';
import { checkFileScope } from '../tasks.ts';
import type { RunAgent } from './claude_cli.ts';
import type { AdjudicationResult, AdjudicationTask, DeviationRecord, InterfaceSummary, SkippedFile, SourceFile } from './architect.ts';
import type { CompactRun, RejectReason, ReviewReport, ReviewTask } from './qa.ts';
import type { EnvFailure, EnvPlan } from './env_steward.ts';
import type { ReleaseInput, ReleasePlan } from './release_manager.ts';
import type { Blocker, EnvFacts } from '../presets/typescript_setup.ts';
import type { AttentionItem, BaselineCheck, CheckOutcome, CriterionResult, EvidenceCheck, EvidenceItem } from '../evidence.ts';
import type { AcceptanceCriterion } from '../tasks.ts';
import type { ProjectProfile } from '../../shared/project_profile.ts';

export interface AgentError {
  code: string;
  message: string;
}

// The error shape agents and checks throw: an Error carrying a code.
type CodedError = Error & { code?: string };

export type ReadFiles = (root: string, paths: string[]) => Promise<{ files: SourceFile[]; skipped: SkippedFile[] }>;

export interface SummaryResult {
  summary: InterfaceSummary | null;
  text: string | null;
  read: { path: string; sha: string | undefined }[];
  skipped: SkippedFile[];
  costUsd: number;
  error: AgentError | null;
}

// A check as configured for the submit stage; `line` is its command line,
// which a baseline must match.
export type SubmitCheck = EvidenceCheck & { line: string };

export type CollectChanges = typeof collectChanges;

export interface ReviewResult {
  passed: boolean;
  reasons: RejectReason[];
  evidence: EvidenceItem[];
  attention: AttentionItem[];
  checks: (EvidenceItem & { run: CompactRun | null })[];
  verification: CompactRun | null;
  acceptance: CriterionResult[];
  report: ReviewReport | null;
  diff: {
    files: { path: string; bytes: number; untracked: boolean }[];
    skipped: SkippedFile[];
    outOfScope: string[];
  };
  costUsd: number;
}

export interface EnvPlanResult {
  facts: EnvFacts;
  blockers: Blocker[];
  plan: EnvPlan | null;
  costUsd: number;
}

export type EnvProbe = (root: string, options: { envPath?: string | null }) => Promise<EnvFacts>;

export type AdjudicationOutcome = AdjudicationResult & {
  read: string[];
  skipped: SkippedFile[];
  costUsd: number;
};

// Stops between steps when the run was cancelled, whatever the runner does.
export const throwIfCancelled = (signal: AbortSignal | null | undefined): void => {
  if (signal?.aborted) throw Object.assign(new Error('Agent run was cancelled'), { code: 'agent_cancelled' });
};

// deps.runAgent:  claude_cli.runStructured or a stand-in
// deps.root:      repository root, or null when none is configured
// deps.files:     tracked file list (already capped)
// deps.readFiles: optional (root, paths) => {files, skipped}, for tests
// deps.profile:   the repository's profile, or null
export const summarizeForRequirement = async (
  { title, text }: { title?: string | null; text: string },
  {
    runAgent,
    root,
    files,
    profile = null,
    envPath,
    signal,
    readFiles = readTracked,
  }: {
    runAgent: RunAgent;
    root: string | null;
    files: string[];
    profile?: ProjectProfile | null;
    envPath?: string | null;
    signal?: AbortSignal;
    readFiles?: ReadFiles;
  },
): Promise<SummaryResult> => {
  const empty: SummaryResult = { summary: null, text: null, read: [], skipped: [], costUsd: 0, error: null };
  if (!root || files.length === 0) return empty;
  let costUsd = 0;
  try {
    throwIfCancelled(signal);
    const selected = await runAgent({
      prompt: architect.selectPrompt({ title, text, files, profile }),
      systemPrompt: architect.SYSTEM_PROMPT,
      schema: architect.SELECT_SCHEMA,
      envPath,
      signal,
    });
    costUsd += selected.costUsd ?? 0;
    const paths = architect.validateSelection(selected.output, files);
    if (paths.length === 0) return { ...empty, costUsd };

    const { files: sources, skipped } = await readFiles(root, paths);
    if (sources.length === 0) return { ...empty, skipped, costUsd };

    throwIfCancelled(signal);
    const summarized = await runAgent({
      prompt: architect.summarizePrompt({ title, text, files, sources, skipped, profile }),
      systemPrompt: architect.SYSTEM_PROMPT,
      schema: architect.SUMMARY_SCHEMA,
      envPath,
      signal,
    });
    costUsd += summarized.costUsd ?? 0;
    const summary = architect.validateSummary(summarized.output, { readPaths: sources.map((s) => s.path), files });
    return {
      summary,
      text: architect.formatSummary(summary),
      // Path and blob sha of each file read, so a cached summary can be
      // checked against the current index.
      read: sources.map((s) => ({ path: s.path, sha: s.sha })),
      skipped,
      costUsd,
      error: null,
    };
  } catch (error) {
    const coded = error as CodedError;
    // Cancellation must stop the whole run, not degrade to a plan without
    // a summary.
    if (coded.code === 'agent_cancelled') throw error;
    return { ...empty, costUsd, error: { code: coded.code ?? 'agent_failed', message: coded.message } };
  }
};

// Runs QA's review of a submitted work package: the submit-stage checks, the
// diff since the baseline, then the model. When the outcome is already
// certain (nothing changed, or a blocking check failed) the model is not
// called; there is nothing it could add, and it would only cost money.
//
// task: work package definition
// deps.checks:    submit-stage checks
// deps.runCheck:  (kind, signal) => verification.runCheck() result.
//   not_configured skips the check; any other error is thrown.
// deps.baselines: {kind: evidence.baselineRecord()} measured at claim
// deps.ignore:    (path) => true for files the checks wrote
// deps.runAgent:  claude_cli.runStructured or a stand-in
// deps.collect:   optional review_diff.collectChanges, for tests
// deps.interfaces: Architect's formatted summary, or null
// deps.profile:   the repository's profile, or null
export const reviewWorkPackage = async (
  task: ReviewTask & { acceptance?: AcceptanceCriterion[] },
  {
    root,
    baseline,
    runAgent,
    checks = [],
    runCheck,
    baselines = {},
    ignore,
    collect = collectChanges,
    interfaces = null,
    profile = null,
    envPath,
    signal,
  }: {
    root: string;
    baseline: string;
    runAgent: RunAgent;
    checks?: SubmitCheck[];
    runCheck: (kind: string, signal?: AbortSignal) => Promise<CheckOutcome>;
    baselines?: Partial<Record<string, BaselineCheck | null>>;
    ignore?: (path: string) => boolean;
    collect?: CollectChanges;
    interfaces?: string | null;
    profile?: ProjectProfile | null;
    envPath?: string | null;
    signal?: AbortSignal;
  },
): Promise<ReviewResult> => {
  throwIfCancelled(signal);
  const runs: Record<string, CheckOutcome> = {};
  for (const check of checks) {
    try {
      runs[check.kind] = await runCheck(check.kind, signal);
    } catch (error) {
      // Removed from the config since the review started: nothing to judge.
      // Anything else (a missing executable, say) fails the review so the
      // environment gets fixed and the review retried.
      if ((error as CodedError).code !== 'not_configured') throw error;
    }
    throwIfCancelled(signal);
  }
  const ran = checks.filter((check) => runs[check.kind]);
  const items = ran.map((check) => evidence.evaluate(check, runs[check.kind], evidence.usableBaseline(baselines[check.kind], check.line)));
  const acceptance = evidence.criteriaStatus(task.acceptance ?? [], runs, items, baselines);
  const paired = ran.map((check, index) => ({ evidence: items[index], run: runs[check.kind] }));

  const scope = new Set(task.fileScope ?? []);
  const collected = await collect(root, baseline, { prioritize: (p) => scope.has(p), ...(ignore ? { ignore } : {}) });
  const changedPaths = collected.changes.map((c) => c.path);
  const diff = {
    files: collected.files.map((f) => ({ path: f.path, bytes: f.bytes, untracked: f.untracked })),
    skipped: collected.skipped,
    outOfScope: checkFileScope(task, changedPaths).outOfScope,
  };
  const result = (report: ReviewReport | null, costUsd: number): ReviewResult => {
    const reasons = qa.decide({ evidence: items, acceptance, changeCount: changedPaths.length, report });
    return {
      passed: reasons.length === 0,
      reasons,
      evidence: items,
      attention: evidence.attention(items, acceptance),
      checks: paired.map(({ evidence: e, run }) => ({ ...e, run: qa.compactRun(run) })),
      verification: qa.compactRun(runs.test ?? null),
      acceptance,
      report,
      diff,
      costUsd,
    };
  };

  const settled = result(null, 0);
  if (settled.reasons.includes('no_changes') || settled.reasons.includes('tests_failed')) return settled;

  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: qa.reviewPrompt({ task, acceptance, checks: paired, diff: { ...diff, files: collected.files }, interfaces, profile }),
    systemPrompt: qa.SYSTEM_PROMPT,
    schema: qa.REVIEW_SCHEMA,
    envPath,
    signal,
  });
  const report = qa.validateReview(output, { criteriaCount: acceptance.length, changedPaths });
  return result(report, costUsd ?? 0);
};

// Environment Steward's turn: probe the workspace, then ask the model to pick
// an install mode and verification scripts. Without a usable package.json
// there is nothing to choose, so the model is not called.
//
// deps.failure: optional failed step
export const planEnvironment = async ({
  root,
  runAgent,
  envPath,
  signal,
  failure = null,
  probe = envSetup.probe,
}: {
  root: string;
  runAgent: RunAgent;
  envPath?: string | null;
  signal?: AbortSignal;
  failure?: EnvFailure | null;
  probe?: EnvProbe;
}): Promise<EnvPlanResult> => {
  const facts = await probe(root, { envPath });
  const found = envSetup.blockers(facts);
  if (found.includes('no_manifest') || found.includes('invalid_manifest')) {
    return { facts, blockers: found, plan: null, costUsd: 0 };
  }
  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: envSteward.planPrompt(facts, { failure }),
    systemPrompt: envSteward.SYSTEM_PROMPT,
    schema: envSteward.PLAN_SCHEMA,
    envPath,
    signal,
  });
  return { facts, blockers: found, plan: envSteward.validatePlan(output, facts), costUsd: costUsd ?? 0 };
};

// Architect's ruling on the package's latest deviation. Reads the files the
// package and its deviations name (tracked files at HEAD only, through
// repo_reader), then asks for dismiss or replan.
//
// task: effective work package definition
// deps.deviations: every deviation on the package; the last is judged
// deps.mustReplan: the developer contested an earlier dismissal
// deps.profile:    the repository's profile, or null
export const adjudicateDeviation = async (
  task: AdjudicationTask,
  {
    root,
    deviations,
    mustReplan = false,
    runAgent,
    interfaces = null,
    profile = null,
    envPath,
    signal,
    readFiles = readTracked,
  }: {
    root: string | null;
    deviations: DeviationRecord[];
    mustReplan?: boolean;
    runAgent: RunAgent;
    interfaces?: string | null;
    profile?: ProjectProfile | null;
    envPath?: string | null;
    signal?: AbortSignal;
    readFiles?: ReadFiles;
  },
): Promise<AdjudicationOutcome> => {
  throwIfCancelled(signal);
  const wanted = [...task.fileScope, ...deviations.map((d) => d.filePath).filter((p): p is string => Boolean(p))];
  const { files: sources, skipped } = root ? await readFiles(root, wanted) : { files: [], skipped: [] };
  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: architect.adjudicatePrompt({ task, deviations, mustReplan, interfaces, sources, skipped, profile }),
    systemPrompt: architect.ADJUDICATE_SYSTEM_PROMPT,
    schema: architect.ADJUDICATE_SCHEMA,
    envPath,
    signal,
  });
  return {
    ...architect.validateAdjudication(output, { mustReplan }),
    read: sources.map((s) => s.path),
    skipped,
    costUsd: costUsd ?? 0,
  };
};

export const RELEASE_MAX_COMMITS = 200;
export const RELEASE_MAX_FILES = 500;

export type ReleasePackage = ReleaseInput['packages'][number];

export interface ReleasePlanResult {
  input: ReleaseInput;
  plan: ReleasePlan;
  costUsd: number;
}

// Reads the version committed at `commit` and names the file it came from.
// The caller picks the reader for the repository's language; agents never
// read manifests themselves.
export type ReadVersion = (root: string, commit: string) => Promise<{ file: string; value: string | null }>;

// Everything Release Manager sees, from committed history only: subjects,
// changed paths with line counts (secret-looking paths dropped), and the
// version at the release commit. No file contents.
export const collectReleaseInput = async (
  root: string,
  {
    startCommit,
    startLabel,
    endCommit,
    packages,
    readVersion,
  }: {
    startCommit: string;
    startLabel: string;
    endCommit: string;
    packages: ReleasePackage[];
    readVersion: ReadVersion;
  },
): Promise<ReleaseInput> => {
  const [range, changes, version] = await Promise.all([
    git.commitRange(root, startCommit, endCommit, { limit: RELEASE_MAX_COMMITS }),
    git.rangeStat(root, startCommit, endCommit),
    readVersion(root, endCommit),
  ]);
  const files = changes.filter((change) => !looksSecret(change.path));
  return {
    currentVersion: version.value,
    versionFile: version.file,
    startCommit,
    startLabel,
    endCommit,
    commits: range.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
    commitsTruncated: range.truncated,
    files: files.slice(0, RELEASE_MAX_FILES),
    filesTruncated: files.length > RELEASE_MAX_FILES,
    packages,
  };
};

// Release Manager's turn: collect the input, then ask for a bump, notes and
// a checklist. Nothing to release (no commits) fails before the model runs.
export const planRelease = async ({
  root,
  startCommit,
  startLabel,
  endCommit,
  packages,
  readVersion,
  runAgent,
  envPath,
  signal,
}: {
  root: string;
  startCommit: string;
  startLabel: string;
  endCommit: string;
  packages: ReleasePackage[];
  readVersion: ReadVersion;
  runAgent: RunAgent;
  envPath?: string | null;
  signal?: AbortSignal;
}): Promise<ReleasePlanResult> => {
  throwIfCancelled(signal);
  const input = await collectReleaseInput(root, { startCommit, startLabel, endCommit, packages, readVersion });
  if (input.commits.length === 0) throw Object.assign(new Error('There are no commits since the start point'), { code: 'release_no_changes' });
  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: releaseManager.planPrompt(input),
    systemPrompt: releaseManager.SYSTEM_PROMPT,
    schema: releaseManager.PLAN_SCHEMA,
    envPath,
    signal,
  });
  return { input, plan: releaseManager.validatePlan(output, input), costUsd: costUsd ?? 0 };
};

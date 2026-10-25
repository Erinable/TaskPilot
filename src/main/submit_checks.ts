// The submit-stage checks of a workspace config, as reviews, baselines and
// the coding loop run and compare them.
import * as workspace from './workspace.ts';

// A submit-stage check, with the line its baseline is keyed by.
export type SubmitCheck = { kind: workspace.CheckKind; stage: workspace.CheckStage; blocking: boolean; line: string };

// The command line plus whatever else changes what a check measures.
export const checkLine = (check: workspace.Check) => {
  const extras: string[] = [];
  if (check.report.format === 'junit') extras.push(`[junit ${check.report.path}]`);
  const env = Object.entries(check.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  if (env.length) extras.push(`[env ${env.join(' ')}]`);
  return [workspace.formatCommandLine(check), ...extras].join(' ');
};

// Checks that run before review, with the line their baselines are keyed by.
export const submitChecks = (config: workspace.WorkspaceConfig): SubmitCheck[] =>
  workspace.COMMAND_KINDS.flatMap((kind) => {
    const check = config.checks?.[kind];
    return check?.stage === 'submit' ? [{ kind, stage: check.stage, blocking: check.blocking, line: checkLine(check) }] : [];
  });

// Report files the checks write are not the package's changes.
export const reportIgnore = (config: workspace.WorkspaceConfig) => {
  const paths = new Set(
    workspace.COMMAND_KINDS.map((kind) => config.checks?.[kind]?.report).flatMap((report) => (report?.format === 'junit' ? [report.path] : [])),
  );
  return (candidate: string) => paths.has(candidate) || candidate.startsWith('.taskpilot/');
};

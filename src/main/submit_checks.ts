// The submit-stage steps of a repository, as reviews, baselines and the
// coding loop run and compare them.
import { formatCommandLine } from './command_line.ts';
import type { StepId } from '../shared/check_steps.ts';
import type { CheckStage, CheckStep } from './step_config.ts';

// A submit-stage step, with the line its baseline is keyed by.
export type SubmitCheck = { kind: StepId; stage: CheckStage; blocking: boolean; line: string; step: CheckStep };

// The command lines plus whatever else changes what a step measures. A
// single command with the default parser and directory keeps the line a v2
// check had, so baselines recorded before steps still match.
export const checkLine = (step: CheckStep) => {
  const extras: string[] = [];
  if (step.cwd) extras.push(`[cwd ${step.cwd}]`);
  const parser = step.parser;
  if (parser.format === 'junit') extras.push(`[junit ${parser.path}]`);
  else if (parser.format !== 'tests')
    extras.push(`[${parser.format}${'dialect' in parser ? ` ${parser.dialect}` : ''}${'path' in parser && parser.path ? ` ${parser.path}` : ''}]`);
  const env = Object.entries(step.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  if (env.length) extras.push(`[env ${env.join(' ')}]`);
  return [step.commands.map(formatCommandLine).join(' && '), ...extras].join(' ');
};

// Steps that run before review, with the line their baselines are keyed by.
export const submitChecks = (steps: CheckStep[]): SubmitCheck[] =>
  steps.flatMap((step) => (step.stage === 'submit' ? [{ kind: step.id, stage: step.stage, blocking: step.blocking, line: checkLine(step), step }] : []));

// Report files the steps write are not the package's changes. Course packs
// under .taskpilot/courses/ are the repository's files, so a change to one
// is shown.
export const reportIgnore = (steps: CheckStep[]) => {
  const paths = new Set(steps.flatMap((step) => ('path' in step.parser && step.parser.path ? [[step.cwd, step.parser.path].filter(Boolean).join('/')] : [])));
  return (candidate: string) => paths.has(candidate) || (candidate.startsWith('.taskpilot/') && !candidate.startsWith('.taskpilot/courses/'));
};

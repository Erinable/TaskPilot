// A course lab's hidden tests at review time: the student's working tree is
// copied into a scratch folder with the lab's private hidden/ files in
// place of the public tests, and `make grade` runs there under the same
// offline sandbox as the self-check (./lab_verify.ts). The outcome is one
// more blocking check for QA, decided by TaskPilot like a failing public
// test, never left to the model.
//
// [人工决策-2026-10-27 00:51:12] 隐藏测试失败时只显示测试名：结果里只留测试名和通过/失败，
// 不留输出，测试脚本（输入和期望值）不进 QA / Tutor 的 prompt，也不经 IPC 下发。
import fs from 'node:fs/promises';
import path from 'node:path';

import { errorCode } from './coded_error.ts';
import * as git from './git.ts';
import * as labs from './labs.ts';
import * as verification from './verification.ts';
import { looksSecret } from './repo_reader.ts';
import type { EvidenceItem, RunFailure } from './evidence.ts';
import type { Grader } from './lab_verify.ts';
import type { CheckRun } from './verification.ts';

// The check's id beside the repository's own steps.
export const HIDDEN_CHECK_KIND = 'custom:hidden-tests';
const COMMAND = 'make grade (hidden tests)';
const MAX_FILE_BYTES = 1024 * 1024;

// The working tree as `make grade` needs it: git's files (tracked or new,
// never ignored ones such as build/), without secret-looking or large ones.
// The public tests are left out unless `publicTests` (the next stage's
// self-check runs them as the earlier stages' regression tests).
export const workingTree = async (root: string, { publicTests = false }: { publicTests?: boolean } = {}): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const file of await git.workingFiles(root)) {
    if (looksSecret(file) || (!publicTests && file.startsWith(`${labs.PUBLIC_TESTS_DIR}/`))) continue;
    const stat = await fs.lstat(path.join(root, file)).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
    files[file] = await fs.readFile(path.join(root, file), 'utf8');
  }
  return files;
};

// What TaskPilot concludes from the run: every hidden test reported a pass.
// No baseline: the starter fails them all by design.
const evidenceOf = (run: CheckRun | RunFailure): EvidenceItem => {
  const base: Omit<EvidenceItem, 'status' | 'reason' | 'newFailures'> = {
    kind: HIDDEN_CHECK_KIND,
    stage: 'submit',
    blocking: true,
    baseline: 'none',
    preexisting: [],
    fixed: [],
  };
  if ('error' in run) return { ...base, status: 'unverifiable', reason: run.error.code ?? 'not_run', newFailures: [] };
  const failing = run.results.filter((result) => !result.passed).map((result) => result.name);
  if (run.exitCode !== 0 || !run.results.length) return { ...base, status: 'fail', reason: 'crashed', newFailures: failing };
  return failing.length
    ? { ...base, status: 'fail', reason: 'hidden_failed', newFailures: failing }
    : { ...base, status: 'pass', reason: null, newFailures: [] };
};

// Runs a lab's hidden tests on the working tree at `root`. TaskPilot's own
// Makefile and tests/grade.sh replace the repository's, so the student's
// edits to them cannot change what runs. A grader that cannot run (no
// sandbox) leaves the check unverifiable rather than failing the student.
export const runHiddenTests = async ({
  root,
  dataDir,
  labId,
  grader,
  envPath,
  signal,
}: {
  root: string;
  dataDir: string;
  labId: string;
  grader: Grader;
  envPath?: string | null;
  signal?: AbortSignal;
}): Promise<{ evidence: EvidenceItem; run: CheckRun | RunFailure } | null> => {
  const hidden = await labs.readHidden(dataDir, labId);
  if (!Object.keys(hidden).length) return null;
  const files = {
    ...(await workingTree(root)),
    Makefile: labs.MAKEFILE,
    [labs.GRADE_SCRIPT_PATH]: labs.GRADE_SCRIPT,
    ...Object.fromEntries(Object.entries(hidden).map(([name, script]) => [`${labs.PUBLIC_TESTS_DIR}/${name}`, script])),
  };
  const startedAt = Date.now();
  let run: CheckRun | RunFailure;
  try {
    const graded = await grader(files, { signal, envPath });
    const results = Object.entries(graded.results).map(([name, passed]) => ({ name, fullName: name, passed, skipped: false, todo: false }));
    const exitCode = graded.built ? 0 : 1;
    run = {
      kind: HIDDEN_CHECK_KIND,
      command: COMMAND,
      exitCode,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      // Never the output: a failing script's stderr could show an input.
      output: '',
      results,
      summary: verification.summarize(results, exitCode),
      report: { format: 'tests', trusted: true, problem: null },
      diagnostics: [],
      check: { stage: 'submit', blocking: true },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[hidden-tests] could not run', error);
    run = { error: { code: errorCode(error) ?? 'failed', message: 'The hidden tests could not run' } };
  }
  const evidence = evidenceOf(run);
  console.debug(`[hidden-tests] lab=${labId} status=${evidence.status} reason=${evidence.reason} failing=${evidence.newFailures.length}`);
  return { evidence, run };
};

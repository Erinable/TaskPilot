// Runs a generated lab the way a lab repository does: TaskPilot's Makefile
// and tests/grade.sh around the lab's files, `make grade` on the starter
// code, then with the reference patch applied and the hidden tests beside
// the public ones. The model's code runs under the Coding Agent's Seatbelt
// profile (src/main/coding/coding_sandbox.ts): writes only inside its folder and the
// temporary directory, no reads of the home folder.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as labs from '../../src/main/courses/labs.ts';
import { SANDBOX_EXEC_PATH, buildProfile } from '../../src/main/coding/coding_sandbox.ts';
import type { CheckResult } from '../shared/harness.ts';
import type { GeneratedLab } from '../../src/main/agents/lab_generator.ts';
import { buildRules } from '../../src/shared/lab_toolchains.ts';
import type { LabToolchainId } from '../../src/shared/lab_toolchains.ts';

const run = promisify(execFile);
const GRADE_TIMEOUT_MS = 120_000;

// Results by test name, as a plain object so the report keeps them.
type Grade = { built: boolean; results: Record<string, boolean>; output: string };

const parseTap = (stdout: string): Record<string, boolean> =>
  Object.fromEntries([...stdout.matchAll(/^(not )?ok \d+ - (.*)$/gm)].map((match) => [match[2].trim(), match[1] === undefined]));

const grade = async (root: string): Promise<Grade> => {
  const profile = buildProfile({ home: os.homedir(), runDir: root, writable: [], readable: [] });
  try {
    const { stdout } = await run(SANDBOX_EXEC_PATH, ['-p', profile, 'make', 'grade'], { cwd: root, timeout: GRADE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return { built: true, results: parseTap(stdout), output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    return { built: false, results: parseTap(failure.stdout ?? ''), output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message}`.slice(-2000) };
  }
};

const writeAll = async (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
};

export type LabRun = { starter: Grade; reference: Grade };

// The starter repository, with TaskPilot's build rules for the toolchain,
// then the reference and hidden tests over it.
export const runLab = async (artifact: labs.LabArtifact, toolchain: LabToolchainId): Promise<LabRun> => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tp-eval-lab-')));
  try {
    await writeAll(root, {
      Makefile: labs.MAKEFILE,
      [labs.GRADE_SCRIPT_PATH]: labs.GRADE_SCRIPT,
      [labs.BUILD_RULES_PATH]: buildRules(toolchain, [{ program: artifact.program, sources: artifact.sources }]),
      ...labs.repositoryFiles(artifact, 1),
    });
    const starter = await grade(root);
    await run('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(path.join(root, '.reference.patch'), artifact.private.reference);
    await run('git', ['apply', '.reference.patch'], { cwd: root });
    await writeAll(root, Object.fromEntries(Object.entries(artifact.private.hidden).map(([name, content]) => [`tests/public/${name}`, content])));
    return { starter, reference: await grade(root) };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const names = (files: GeneratedLab['publicTests']) => files.flatMap((file) => file.names);
const missing = (wanted: string[], results: Record<string, boolean>) => wanted.filter((name) => !(name in results));

// `runs` is the eval's criterion: the lab validated, and both the starter
// and the reference build and report every test they should. The rest is
// what T5's self-check will demand, measured here for the record.
export const check = (lab: GeneratedLab | null, error: string | null, labRun: LabRun | null): Record<string, CheckResult> => {
  if (!lab || !labRun) return { validates: { pass: false, detail: error ?? 'no lab' }, runs: { pass: false, detail: 'not run' } };
  const publicNames = names(lab.publicTests);
  const allNames = [...publicNames, ...names(lab.hiddenTests)];
  const starterMissing = missing(publicNames, labRun.starter.results);
  const referenceMissing = missing(allNames, labRun.reference.results);
  const referenceFailed = allNames.filter((name) => labRun.reference.results[name] === false);
  const starterPassed = publicNames.filter((name) => labRun.starter.results[name] === true);
  const runs = labRun.starter.built && labRun.reference.built && !starterMissing.length && !referenceMissing.length;
  return {
    validates: { pass: true, detail: `${publicNames.length} public, ${allNames.length - publicNames.length} hidden tests` },
    runs: {
      pass: runs,
      detail: runs
        ? 'starter and reference build and report every test'
        : `starter built=${labRun.starter.built} missing=${starterMissing.join('|')}; reference built=${labRun.reference.built} missing=${referenceMissing.join('|')}; ${labRun.reference.output.slice(-400)}`,
    },
    referencePasses: { pass: runs && !referenceFailed.length, detail: referenceFailed.length ? `fails ${referenceFailed.join('|')}` : 'all pass' },
    starterFails: {
      pass: runs && !starterPassed.length,
      detail: starterPassed.length ? `starter already passes ${starterPassed.join('|')}` : 'every public test fails',
    },
  };
};

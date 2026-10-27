// Course labs: what one lab is made of, which part the student sees and
// which part stays with TaskPilot, and the work package each lab becomes.
// ./lab_service.ts writes them.
//
// A lab repository is staged (CodeCrafters style): lab N is stage N, its
// public tests are tests/public/NN_*.sh, and `make grade` runs every stage's
// public tests so far, so a later stage also re-checks the earlier ones.
//
// Seen by the student, committed to the lab repository:
//   labs/NN-<id>/README.md, the starter code, tests/public/, tests/build.mk,
//   tests/grade.sh, Makefile, taskpilot.toml (`labs`), .taskpilot/course_plan.toml
// Private, in the repository's data directory and never in its git, never
// sent to the renderer, never in a Coding Agent run directory (those are a
// `git archive` of the baseline, and this directory is outside the
// repository):
//   userData/repos/<repoId>/labs/<labId>/reference.patch, hidden/, hints.json, rubric.json, verify.json
//
// [人工决策-2026-10-27 00:36:21] lab 只做"仓库 + 测试"：题面、初始代码、公开测试在仓库里，参考解、隐藏测试、提示梯度留在仓库外。
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';

import { codedError } from './coded_error.ts';
import { looksSecret } from './repo_reader.ts';
import { normalizeRelativePath } from './step_config.ts';
import { formatEstimate } from './agents/product_lead.ts';
import { CONTROL_CHARS } from '../shared/text_rules.ts';
import * as projectConfig from './project_config.ts';
import type { TaskDefinition } from './tasks.ts';
import type { AcceptanceCriterion } from '../shared/ipc/workspace.ts';
import type { PackageDifficulty } from '../shared/ipc/packages.ts';
import { isCourseId } from '../shared/course_pack.ts';
import type { Concept, CourseRef } from '../shared/course_pack.ts';
import type { LabEntry } from './project_config.ts';

const LABS_DIRNAME = 'labs';
export const REFERENCE_FILENAME = 'reference.patch';
export const HIDDEN_DIRNAME = 'hidden';
const HINTS_FILENAME = 'hints.json';
const VERIFY_FILENAME = 'verify.json';
const RUBRIC_FILENAME = 'rubric.json';
export const COURSE_PLAN_PATH = '.taskpilot/course_plan.toml';
export const PUBLIC_TESTS_DIR = 'tests/public';
export const BUILD_RULES_PATH = 'tests/build.mk';
export const GRADE_SCRIPT_PATH = 'tests/grade.sh';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LAB_BYTES = 512 * 1024;
const MAX_FILES = 32;
const MAX_HINTS = 5;

// One rung of the hint ladder, L1 to L5; T7's Tutor falls back on these.
type LabHint = { level: number; text: string; code: string | null };

// The parts of a lab only TaskPilot keeps. `verify` is the self-check
// report, null until one has run; `rubric` is what grading looks for in this
// lab under the pack's rubric ids (absent on hand-written labs).
export type LabPrivate = { reference: string; hidden: Record<string, string>; hints: LabHint[]; verify: unknown; rubric?: { id: string; note: string }[] };

// One lab as the generator (or a fixture) hands it over.
export type LabArtifact = {
  id: string;
  title: string;
  summary: string;
  difficulty: PackageDifficulty;
  estimateHours: number;
  concepts: string[];
  // The task statement, labs/NN-<id>/README.md.
  readme: string;
  steps: string[];
  // Linked tests name public tests as tests/grade.sh prints them.
  acceptance: AcceptanceCriterion[];
  // Starter code by repository path; new files only, never TaskPilot's own.
  files: Record<string, string>;
  // The files the student edits.
  fileScope: string[];
  // By file name in tests/public/: NN_<name>.sh, NN being the stage.
  publicTests: Record<string, string>;
  // tests/build.mk: the first lab must give it, a later one may replace it.
  build: string | null;
  private: LabPrivate;
};

// The student's path through the course pack (.taskpilot/course_plan.toml).
// The goal interview (CARM-38) owns `goal` and `extraConcepts`.
export type CoursePlan = {
  course: string;
  path: { conceptId: string; status: 'planned' | 'known' | 'skipped' }[];
  goal?: Record<string, unknown>;
  extraConcepts?: Concept[];
};

const fail = (message: string, field: string): never => {
  throw codedError(`${field}: ${message}`, 'invalid_lab', field);
};

// TaskPilot's own files in a lab repository; starter code never goes there.
const OWNED = /^(?:labs\/|tests\/|\.taskpilot\/|\.git(?:\/|ignore$|$)|(?:Makefile|makefile|GNUmakefile|taskpilot\.toml)$)/;
const isOwnedPath = (file: string) => OWNED.test(file);

const stageDir = (lab: Pick<LabEntry, 'id' | 'stage'>) => `${LABS_DIRNAME}/${String(lab.stage).padStart(2, '0')}-${lab.id}`;

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) return fail('must be text', field);
  if (Buffer.byteLength(value) > max) fail(`must be at most ${max} bytes`, field);
  if (CONTROL_CHARS.test(value)) fail('contains control characters', field);
  return value;
};

const repoPath = (value: unknown, field: string): string => {
  let clean = '';
  try {
    clean = normalizeRelativePath(value, field);
  } catch (error) {
    throw codedError((error as Error).message, 'invalid_lab', field);
  }
  if (looksSecret(clean)) fail('looks like a secret file', field);
  return clean;
};

// A file name directly inside a lab folder (hidden/, tests/public/).
const FLAT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const fileMap = (value: Record<string, string>, field: string, check: (name: string, at: string) => string): Record<string, string> => {
  const names = Object.keys(value);
  if (names.length > MAX_FILES) fail(`allows at most ${MAX_FILES} files`, field);
  return Object.fromEntries(
    names.map((name) => [check(name, `${field}[${JSON.stringify(name)}]`), text(value[name], `${field}[${JSON.stringify(name)}]`, MAX_FILE_BYTES)]),
  );
};

const hints = (value: LabHint[]): LabHint[] => {
  if (!Array.isArray(value) || value.length > MAX_HINTS) return fail(`must be at most ${MAX_HINTS} hints`, 'private.hints');
  return value.map((hint, index) => {
    const field = `private.hints[${index}]`;
    if (!Number.isInteger(hint?.level) || hint.level < 1 || hint.level > MAX_HINTS || value.findIndex((other) => other.level === hint.level) !== index)
      fail('needs a level from 1 to 5, each used once', `${field}.level`);
    return { level: hint.level, text: text(hint.text, `${field}.text`, 4000), code: hint.code === null ? null : text(hint.code, `${field}.code`, 4000) };
  });
};

// Checks a lab for `stage` before anything is written: every path stays in
// the repository and out of TaskPilot's own files, public tests carry the
// stage number, and the whole lab is bounded.
export const checkLab = (lab: LabArtifact, stage: number): LabArtifact => {
  if (!projectConfig.isLabId(lab.id)) fail('must be lowercase letters, digits or -, starting with a letter', 'id');
  if (!Array.isArray(lab.concepts) || !lab.concepts.every(projectConfig.isLabConcept)) fail('must be concept ids', 'concepts');
  const files = fileMap(lab.files, 'files', (name, at) => {
    const clean = repoPath(name, at);
    return isOwnedPath(clean) ? fail('is a TaskPilot file; starter code goes elsewhere', at) : clean;
  });
  const prefix = `${String(stage).padStart(2, '0')}_`;
  const publicTests = fileMap(lab.publicTests, 'publicTests', (name, at) =>
    FLAT_NAME.test(name) && name.startsWith(prefix) && name.endsWith('.sh') ? name : fail(`must be named ${prefix}<name>.sh`, at),
  );
  if (Object.keys(publicTests).length === 0) fail('needs at least one public test', 'publicTests');
  const hidden = fileMap(lab.private.hidden, 'private.hidden', (name, at) => (FLAT_NAME.test(name) ? name : fail('must be a plain file name', at)));
  const fileScope = lab.fileScope.map((file, index) => {
    const clean = repoPath(file, `fileScope[${index}]`);
    return isOwnedPath(clean) ? fail('is a TaskPilot file', `fileScope[${index}]`) : clean;
  });
  if (fileScope.length === 0) fail('needs at least one file', 'fileScope');
  if (stage === 1 && lab.build === null) fail('the first lab must give the build rules', 'build');
  const checked: LabArtifact = {
    ...lab,
    readme: text(lab.readme, 'readme', MAX_FILE_BYTES),
    files,
    fileScope,
    publicTests,
    build: lab.build === null ? null : text(lab.build, 'build', MAX_FILE_BYTES),
    private: {
      reference: text(lab.private.reference, 'private.reference', MAX_LAB_BYTES),
      hidden,
      hints: hints(lab.private.hints),
      verify: lab.private.verify ?? null,
      ...(lab.private.rubric
        ? {
            rubric: lab.private.rubric.map((item, index) => ({
              id: isCourseId(item.id) ? item.id : fail('must be a rubric id', `private.rubric[${index}].id`),
              note: text(item.note, `private.rubric[${index}].note`, 1000),
            })),
          }
        : {}),
    },
  };
  if (Buffer.byteLength(JSON.stringify(checked)) > MAX_LAB_BYTES) fail('is larger than 512 KB', 'lab');
  return checked;
};

// The lab's line in taskpilot.toml.
export const labEntry = (lab: LabArtifact, stage: number): LabEntry => ({ id: lab.id, stage, dir: stageDir({ id: lab.id, stage }), concepts: lab.concepts });

// `make grade`: a clean build with tests/build.mk's rules, then every
// stage's public tests.
export const MAKEFILE = [
  '# Written by TaskPilot. `make grade` builds from clean (the rules are in',
  '# tests/build.mk) and runs the public tests of every stage so far, in',
  '# stage order, one TAP line per test.',
  `include ${BUILD_RULES_PATH}`,
  '',
  'grade:',
  '\t@$(MAKE) -s clean',
  '\t@$(MAKE) -s build',
  `\t@sh ${GRADE_SCRIPT_PATH}`,
  '',
  '.PHONY: grade',
  '',
].join('\n');

// Numbers the results of every public test file as TAP. A test file prints
// "ok - <name>" or "not ok - <name>" per test and exits 0.
export const GRADE_SCRIPT = [
  '#!/bin/sh',
  '# Written by TaskPilot. Runs the public tests of every stage so far in stage',
  '# order (tests/public/NN_*.sh) and numbers their results as TAP. A test file',
  '# prints "ok - <name>" or "not ok - <name>" per test and exits 0.',
  `for file in ${PUBLIC_TESTS_DIR}/*.sh; do`,
  '  [ -f "$file" ] || continue',
  '  sh "$file" || echo "not ok - $file exited with status $?"',
  'done | awk \'/^(not )?ok - / { n += 1; sub(/ok - /, "ok " n " - "); print }\'',
  '',
].join('\n');

export const GITIGNORE = ['/build/', '/.taskpilot/*', `!/${COURSE_PLAN_PATH}`, '!/.taskpilot/courses/', ''].join('\n');

// A new lab repository's taskpilot.toml: the pack, the grade step and the labs.
export const projectText = (course: string, labs: LabEntry[]) =>
  [
    '# Written by TaskPilot for a course lab repository. TaskPilot adds each new',
    '# lab below together with its files; `make grade` runs every stage so far.',
    stringifyToml({
      course,
      custom: { grade: { label: '评分', commands: ['make grade'], timeout: 120, required: true, stage: 'submit' } },
    }),
    '',
    labsText(labs),
  ].join('\n');

// [[labs]] tables, appended to an existing file so the student's edits stay.
export const labsText = (labs: LabEntry[]) => `${stringifyToml({ labs })}\n`;

export const coursePlanText = (plan: CoursePlan) =>
  ['# Your path through the course pack. Mark a concept known or skipped, or reorder it.', stringifyToml(plan), ''].join('\n');

// Every repository file a lab adds, by path: what the student sees.
export const repositoryFiles = (lab: LabArtifact, stage: number): Record<string, string> => ({
  [`${stageDir({ id: lab.id, stage })}/README.md`]: lab.readme,
  ...lab.files,
  ...Object.fromEntries(Object.entries(lab.publicTests).map(([name, content]) => [`${PUBLIC_TESTS_DIR}/${name}`, content])),
  ...(lab.build === null ? {} : { [BUILD_RULES_PATH]: lab.build }),
});

// ========== private store ==========

export const labDir = (dataDir: string, labId: string) => path.join(dataDir, LABS_DIRNAME, labId);
export const referencePath = (dataDir: string, labId: string) => path.join(labDir(dataDir, labId), REFERENCE_FILENAME);

// Replaces a lab's private files.
export const writePrivate = async (dataDir: string, labId: string, secret: LabPrivate) => {
  const dir = labDir(dataDir, labId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, HIDDEN_DIRNAME), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, REFERENCE_FILENAME), secret.reference, { mode: 0o600 });
  for (const [name, content] of Object.entries(secret.hidden)) await fs.writeFile(path.join(dir, HIDDEN_DIRNAME, name), content, { mode: 0o600 });
  await fs.writeFile(path.join(dir, HINTS_FILENAME), `${JSON.stringify(secret.hints, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(dir, VERIFY_FILENAME), `${JSON.stringify(secret.verify, null, 2)}\n`, { mode: 0o600 });
  if (secret.rubric) await fs.writeFile(path.join(dir, RUBRIC_FILENAME), `${JSON.stringify(secret.rubric, null, 2)}\n`, { mode: 0o600 });
};

// A lab's hidden test files by name; empty when it has none.
export const readHidden = async (dataDir: string, labId: string): Promise<Record<string, string>> => {
  const dir = path.join(labDir(dataDir, labId), HIDDEN_DIRNAME);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  return Object.fromEntries(
    await Promise.all(names.filter((name) => FLAT_NAME.test(name)).map(async (name) => [name, await fs.readFile(path.join(dir, name), 'utf8')])),
  );
};

// ========== work packages ==========

// The id of a lab's package; lab ids are unique in a repository.
export const packageId = (labId: string) => `lab-${labId}`;

// The practice package a lab becomes. Each stage waits for the one before.
export const toTaskDefinition = (
  lab: LabArtifact,
  { stage, previous, course, requirementId }: { stage: number; previous: string | null; course: CourseRef; requirementId: string },
): TaskDefinition => ({
  id: packageId(lab.id),
  status: 'pending',
  title: lab.title,
  description: lab.summary,
  intro: `课程 lab 第 ${stage} 阶段。题面在 \`${stageDir({ id: lab.id, stage })}/README.md\`，\`make grade\` 会跑到目前为止每个阶段的公开测试。`,
  module: LABS_DIRNAME,
  tags: ['lab', ...lab.concepts],
  priority: 'medium',
  estimate: formatEstimate(lab.estimateHours),
  estimateHours: lab.estimateHours,
  icon: 'flask',
  steps: lab.steps,
  fileScope: lab.fileScope,
  acceptance: lab.acceptance,
  difficulty: lab.difficulty,
  recommendedMode: { mode: 'practice', reason: '这是课程 lab，自己动手写才练得到。' },
  dependsOn: previous ? [previous] : [],
  course,
  concepts: lab.concepts,
  lab: { id: lab.id, stage, difficulty: lab.difficulty.level },
  requirementId,
});

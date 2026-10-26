// Grades one case the way practice_service.ts does: the reference and the
// submission are each written over the committed fixture and read back as
// git diffs (the submission through review_diff.ts), then Tutor's grading
// prompt, schema and validation run with the pack given.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { collectChanges } from '../../src/main/review_diff.ts';
import * as tutor from '../../src/main/agents/tutor.ts';
import { fixtureRepo } from '../shared/harness.ts';
import type { RunAgent } from '../../src/main/agents/claude_cli.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';
import type { GradeCase } from './cases.ts';

const git = promisify(execFile);

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
};

export interface GradeRun {
  report: tutor.GradeReport;
  costUsd: number;
  // What Tutor was shown, for the judge.
  submission: { path: string; patch: string }[];
  reference: string | null;
}

export const gradeCase = async (testCase: GradeCase, course: CoursePack, runAgent: RunAgent): Promise<GradeRun> => {
  const repo = await fixtureRepo(testCase.id, testCase.fixture);
  try {
    let reference: string | null = null;
    if (testCase.reference) {
      await writeFiles(repo.root, testCase.reference);
      reference = (await git('git', ['diff', repo.head], { cwd: repo.root })).stdout;
      await git('git', ['checkout', '-q', '--', '.'], { cwd: repo.root });
    }
    await writeFiles(repo.root, testCase.submission);
    const collected = await collectChanges(repo.root, repo.head);
    const submission = collected.files.map((file) => ({ path: file.path, patch: file.patch }));
    const notes = testCase.notes ?? [];
    const { output, costUsd } = await runAgent({
      prompt: tutor.gradePrompt({ task: testCase.task, submission, reference, review: testCase.review, notes }),
      systemPrompt: tutor.gradeSystemPrompt(course),
      schema: tutor.gradeSchema(course),
    });
    const report = tutor.validateGrade(output, { changedPaths: submission.map((file) => file.path), hasNotes: notes.length > 0, course });
    return { report, costUsd: costUsd ?? 0, submission, reference };
  } finally {
    await repo.cleanup();
  }
};

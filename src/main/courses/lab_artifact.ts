// Private lab drafts and their checked repository artifact.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as git from '../repository/git.ts';
import * as labs from './labs.ts';
import type * as generator from '../agents/lab_generator.ts';
import type * as labVerify from './lab_verify.ts';

const DRAFTS_DIRNAME = 'lab_drafts';
const DRAFT_FILENAME = 'lab.json';
const VERIFY_FILENAME = 'verify.json';

// What the generator writes, private: the request it was written for and the
// lab; `costUsd` is the generation's, the self-check's is on its report.
export type LabDraft = { requirementId: string; request: generator.LabRequest; lab: generator.GeneratedLab; costUsd: number };

const draftDir = (configDir: string, requirementId: string) => path.join(configDir, DRAFTS_DIRNAME, encodeURIComponent(requirementId));
export const draftPath = (configDir: string, requirementId: string) => path.join(draftDir(configDir, requirementId), DRAFT_FILENAME);
export const verifyPath = (configDir: string, requirementId: string) => path.join(draftDir(configDir, requirementId), VERIFY_FILENAME);

// The generated lab as a lab artifact (./labs.ts), checked for its stage.
// The reference is the patch from the starter code to the solution, made by
// git in a scratch folder, so the model never writes a patch by hand.
export const toLabArtifact = async (
  lab: generator.GeneratedLab,
  request: generator.LabRequest,
  verify: labVerify.LabVerifyReport | null = null,
): Promise<labs.LabArtifact> => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-diff-'));
  try {
    const write = async (side: string, files: generator.SourceFile[]) => {
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(scratch, side, file.path)), { recursive: true });
        await fs.writeFile(path.join(scratch, side, file.path), file.content);
      }
    };
    const solved = lab.starter.map((file) => lab.solution.find((entry) => entry.path === file.path) ?? file);
    await write('a', lab.starter);
    await write('b', solved);
    const reference = await git.diffFolders(scratch, 'a', 'b');
    const artifact: labs.LabArtifact = {
      id: lab.id,
      title: lab.title,
      summary: lab.summary,
      difficulty: { level: request.difficulty, reason: lab.difficultyReason },
      estimateHours: lab.estimateHours,
      concepts: request.concepts.map((concept) => concept.id),
      readme: lab.readme,
      steps: lab.steps,
      acceptance: lab.acceptance,
      files: Object.fromEntries(lab.starter.map((file) => [file.path, file.content])),
      fileScope: lab.fileScope,
      publicTests: Object.fromEntries(lab.publicTests.map((file) => [file.file, file.script])),
      build: lab.build,
      private: {
        reference,
        hidden: Object.fromEntries(lab.hiddenTests.map((file) => [file.file, file.script])),
        hints: lab.hints,
        verify,
        rubric: lab.rubricNotes,
      },
    };
    return labs.checkLab(artifact, request.stage);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

// Renderer-safe summaries for the private lab generation state. The generated
// solution, tests and hints are deliberately absent from these values.
import type * as generator from '../agents/lab_generator.ts';
import * as labVerify from './lab_verify.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';

export const wireLab = (lab: generator.GeneratedLab): NonNullable<requirementTypes.LabGeneration['lab']> => ({
  id: lab.id,
  title: lab.title,
  summary: lab.summary,
  estimateHours: lab.estimateHours,
  starterFiles: lab.starter.length,
  publicTests: lab.publicTests.reduce((sum, file) => sum + file.names.length, 0),
  hiddenTests: lab.hiddenTests.reduce((sum, file) => sum + file.names.length, 0),
});

// The self-check's progress as the learner sees it: verdicts and counts.
export const verifyState = (round: number, rounds: labVerify.RoundReport[], costUsd: number): requirementTypes.LabVerify => ({
  round,
  maxRounds: labVerify.MAX_ROUNDS,
  rounds: rounds.map(labVerify.wireRound),
  costUsd,
});

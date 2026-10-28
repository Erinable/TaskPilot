// Tutor's help on one step (tutor:*), one level of the hint ladder
// (../hint_ladder.ts) at a time.

import type { ErrorInfo } from './envelope.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';

export type TutorAnswer = {
  explanation: string;
  hints: string[];
  // Always null at L1 to L3.
  snippet: { language: string; code: string } | null;
  terms: { term: string; meaning: string }[];
};

// One opened level. `filtered`: TaskPilot took code out of it (over the
// level's cap, or too close to the reference solution). `source` is 'lab'
// when Tutor could not answer and the lab's pre-written hint stands in.
export type TutorLevel = { level: number; answer: TutorAnswer; filtered: boolean; source: 'tutor' | 'lab'; costUsd: number };

// One step's ladder: the levels opened so far, lowest first, and the state
// of the latest ask: idle (nothing asked, or asked for an older wording),
// running or failed at `pending`, or done.
export type TutorState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  levels: TutorLevel[];
  // The level being asked for or that failed; null otherwise.
  pending: number | null;
  // The highest level opened at this step; the next ask may be one above.
  opened: number;
  maxLevel: number;
  error: ErrorInfo | null;
};

export const tutorContract = {
  get: invoke<[id: string, stepIndex: number], TutorState>('tutor:get'),
  // Opens hint level `level` (at most one above the highest opened);
  // Tutor writes it in the background, poll get() for the answer.
  ask: invoke<[id: string, stepIndex: number, level: number], TutorState>('tutor:ask'),
  cancel: invoke<[id: string, stepIndex: number], boolean>('tutor:cancel'),
  // Counts a copied snippet; returns the package's count.
  copied: invoke<[id: string], number>('tutor:copied'),
} satisfies Contract;

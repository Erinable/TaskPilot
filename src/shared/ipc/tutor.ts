// Tutor's help on one step (tutor:*).

import type { ErrorInfo } from './envelope.ts';

export type TutorAnswer = {
  explanation: string;
  hints: string[];
  snippet: { language: string; code: string } | null;
  terms: { term: string; meaning: string }[];
};

// One step's help: idle (never asked, or asked for an older wording),
// running, done or failed.
export type TutorState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  answer: TutorAnswer | null;
  error: ErrorInfo | null;
  costUsd: number;
};

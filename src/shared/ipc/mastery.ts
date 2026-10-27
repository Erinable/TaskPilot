// Review of notes that carry concepts (mastery:*): the Leitner schedule and
// the notes due on the business day.

// One note's place in the Leitner boxes (1–5). `dueDay` is a business day,
// YYYY-MM-DD in the business time zone, never a UTC or process-local one.
export type ReviewSchedule = { noteId: string; box: number; dueDay: string };

// mastery:reviews: the notes due today, oldest due first, and the business
// day they were counted on. `total` counts every note that carries concepts.
export type ReviewList = { today: string; due: (ReviewSchedule & { title: string; concepts: string[] })[]; total: number };

// How a concept stands for the learner: never attempted, attempted but not
// yet passed, passed at least once, or mastered (../../main/lab_progress.ts).
export type ConceptState = 'new' | 'learning' | 'passed' | 'mastered';

// One graded attempt as the mastery page lists it: when, the package (a lab
// or a project task), its repository and how it went.
export type ConceptAttempt = { at: string; packageId: string; repoId: string; result: 'pass' | 'partial' | 'fail'; independence: number | null };

export type ConceptMastery = {
  id: string;
  label: string;
  summary: string;
  prerequisites: string[];
  state: ConceptState;
  totals: { attempts: number; pass: number; partial: number; fail: number };
  // Newest first, at most the last 20 kept.
  attempts: ConceptAttempt[];
};

// mastery:course: one course pack's concept skeleton with how each concept
// stands, and the most frequent error types across its concepts (top 5).
// `concepts` is empty for a pack without a skeleton.
// `repositories` are the registered lab repositories of this pack (their
// taskpilot.toml names it and lists labs), with how many labs each has.
export type CourseMastery = {
  course: { id: string; title: string };
  concepts: ConceptMastery[];
  errorTypes: { type: string; count: number }[];
  repositories: { id: string; name: string; labs: number; current: boolean }[];
};

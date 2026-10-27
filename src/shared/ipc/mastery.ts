// Review of notes that carry concepts (mastery:*): the Leitner schedule and
// the notes due on the business day.

// One note's place in the Leitner boxes (1–5). `dueDay` is a business day,
// YYYY-MM-DD in the business time zone, never a UTC or process-local one.
export type ReviewSchedule = { noteId: string; box: number; dueDay: string };

// mastery:reviews: the notes due today, oldest due first, and the business
// day they were counted on. `total` counts every note that carries concepts.
export type ReviewList = { today: string; due: (ReviewSchedule & { title: string; concepts: string[] })[]; total: number };

// The mastery page's pure logic: the concept graph as mermaid source,
// coloured by how each concept stands, and what one concept links to
// (its notes, labs and project tasks).
import type * as masteryTypes from '@shared/ipc/mastery.ts';
import type * as noteTypes from '@shared/ipc/notes.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

export const STATE_LABELS: Record<masteryTypes.ConceptState, string> = {
  new: '未开始',
  learning: '学习中',
  passed: '通过过',
  mastered: '已掌握',
};

export const RESULT_LABELS: Record<masteryTypes.ConceptAttempt['result'], string> = { pass: '通过', partial: '部分通过', fail: '未通过' };

// Fill and border per state. Filled nodes carry dark text so they read in
// dark mode too; an unfilled one keeps the theme's text colour.
const STATE_STYLES: Record<masteryTypes.ConceptState, string> = {
  new: 'fill:transparent,stroke:#8a8f9c,stroke-dasharray:4 3',
  learning: 'fill:#f6e3c6,stroke:#c26a0b,color:#16181d',
  passed: 'fill:#d6e2fd,stroke:#3f6bf5,color:#16181d',
  mastered: 'fill:#cdebdc,stroke:#17915b,color:#16181d',
};
// Class names apart from mermaid's own words.
const className = (state: masteryTypes.ConceptState) => `state_${state}`;

// Mermaid node ids must be plain; concept ids may carry - and the ai: prefix.
const nodeId = (index: number) => `c${index}`;

// Labels are quoted mermaid text: quotes and the characters mermaid reads as
// markup are replaced, so a label never becomes syntax.
const label = (text: string) => text.replace(/["<>#;`]/g, ' ').trim() || '?';

// The skeleton as a left-to-right graph, prerequisites pointing at what
// needs them. `selected` gets a thicker border.
export const conceptGraph = (concepts: masteryTypes.ConceptMastery[], selected: string | null): string => {
  const index = new Map(concepts.map((concept, at) => [concept.id, at]));
  const lines = ['flowchart LR'];
  for (const [at, concept] of concepts.entries()) lines.push(`  ${nodeId(at)}["${label(concept.label)}"]`);
  for (const [at, concept] of concepts.entries())
    for (const prerequisite of concept.prerequisites) if (index.has(prerequisite)) lines.push(`  ${nodeId(index.get(prerequisite)!)} --> ${nodeId(at)}`);
  for (const state of Object.keys(STATE_STYLES) as masteryTypes.ConceptState[]) lines.push(`  classDef ${className(state)} ${STATE_STYLES[state]}`);
  for (const [at, concept] of concepts.entries()) lines.push(`  class ${nodeId(at)} ${className(concept.state)}`);
  if (selected && index.has(selected)) lines.push(`  style ${nodeId(index.get(selected)!)} stroke-width:3px`);
  return lines.join('\n');
};

// What one concept links to: the notes that carry it (in this course; a
// note without a course is programming's), and the open repository's
// packages that practise it, labs apart from project tasks.
export const conceptLinks = (conceptId: string, course: string, notes: noteTypes.NoteMeta[], tasks: packageTypes.TaskView[], defaultCourse: string) => {
  const practised = tasks.filter((task) => (task.concepts ?? []).includes(conceptId) && (task.course?.id ?? defaultCourse) === course);
  return {
    notes: notes.filter((note) => note.concepts.includes(conceptId) && (note.course ?? defaultCourse) === course),
    labs: practised.filter((task) => task.lab),
    tasks: practised.filter((task) => !task.lab),
  };
};

// Counts by state, for the course view's summary.
export const stateCounts = (concepts: masteryTypes.ConceptMastery[]): Record<masteryTypes.ConceptState, number> =>
  Object.fromEntries(
    (Object.keys(STATE_LABELS) as masteryTypes.ConceptState[]).map((state) => [state, concepts.filter((concept) => concept.state === state).length]),
  ) as Record<masteryTypes.ConceptState, number>;

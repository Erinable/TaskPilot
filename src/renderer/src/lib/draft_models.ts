// Draft validation accepts unfinished form fields while rejecting malformed
// storage before a Vue template or editor reads it. Business validation stays
// with the existing submit/save path.
import { draftObject, draftStrings } from './local_draft.ts';
import type { CourseDraft } from './course_model.ts';
import type { GoalForm } from '@shared/course_plan.ts';
import { COURSE_DIMENSIONS } from '@shared/course_pack.ts';
import { isLabToolchain } from '@shared/lab_toolchains.ts';

export type ComposeDraft = { kind: 'project' | 'course'; title: string; text: string; form: GoalForm };
export type AnswerDraft = { questions: string[]; answers: string[]; defaults: boolean[]; choice: string | null };

const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const textFields = (value: Record<string, unknown>, names: string[]) => names.every((name) => typeof value[name] === 'string');
const dimension = (value: unknown) => COURSE_DIMENSIONS.includes(value as (typeof COURSE_DIMENSIONS)[number]);

export const isComposeDraft = (value: unknown): value is ComposeDraft => {
  if (!draftObject(value) || !fields(value, ['kind', 'title', 'text', 'form']) || !textFields(value, ['title', 'text'])) return false;
  const form = value.form;
  return (
    (value.kind === 'project' || value.kind === 'course') &&
    draftObject(form) &&
    fields(form, ['level', 'target', 'toolchain', 'environment', 'weeklyHours']) &&
    ['new', 'basic', 'solid'].includes(String(form.level)) &&
    ['concept', 'implement'].includes(String(form.target)) &&
    (form.toolchain === undefined || isLabToolchain(form.toolchain)) &&
    typeof form.environment === 'string' &&
    typeof form.weeklyHours === 'number' &&
    Number.isFinite(form.weeklyHours)
  );
};

export const isAnswerDraft = (value: unknown): value is AnswerDraft =>
  draftObject(value) &&
  fields(value, ['questions', 'answers', 'defaults', 'choice']) &&
  draftStrings(value.questions) &&
  draftStrings(value.answers) &&
  value.questions.length === value.answers.length &&
  Array.isArray(value.defaults) &&
  value.defaults.length === value.answers.length &&
  value.defaults.every((item) => typeof item === 'boolean') &&
  (value.choice === null || typeof value.choice === 'string');

export const isCourseDraft = (value: unknown): value is CourseDraft => {
  if (!draftObject(value)) return false;
  const text = ['id', 'title', 'version', 'domain', 'summary', 'learner', 'referenceGuide'];
  const lists = ['tutorGuide', 'difficultyGuide', 'practiceGuide', 'labGuide', 'languages'];
  if (!fields(value, [...text, ...lists, 'toolchains', 'rubric', 'concepts']) || !textFields(value, text) || !lists.every((key) => draftStrings(value[key])))
    return false;
  if (!Array.isArray(value.toolchains) || !value.toolchains.every(isLabToolchain)) return false;
  if (
    !Array.isArray(value.rubric) ||
    value.rubric.length > 100 ||
    !value.rubric.every(
      (item) =>
        draftObject(item) &&
        fields(item, ['id', 'label', 'description', 'dimension', 'examples']) &&
        textFields(item, ['id', 'label', 'description']) &&
        dimension(item.dimension) &&
        Array.isArray(item.examples) &&
        item.examples.length <= 100 &&
        item.examples.every((entry) => draftObject(entry) && fields(entry, ['observation', 'betterWay']) && textFields(entry, ['observation', 'betterWay'])),
    )
  )
    return false;
  return (
    Array.isArray(value.concepts) &&
    value.concepts.length <= 1000 &&
    value.concepts.every(
      (item) =>
        draftObject(item) &&
        fields(item, ['id', 'label', 'summary', 'dimension', 'prerequisites']) &&
        textFields(item, ['id', 'label', 'summary']) &&
        (item.dimension === undefined || dimension(item.dimension)) &&
        draftStrings(item.prerequisites),
    )
  );
};

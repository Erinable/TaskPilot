// Pure helpers for the course pack page: how a pack's fields, sources and
// changes read, and whether a pack is written for the repository's
// languages. No DOM access, so tests import it directly.
import { COURSE_DIMENSION_LABELS, conceptCycle, isCourseId } from '@shared/course_pack.ts';
import type { CourseChange } from '@shared/course_changes.ts';
import type { Concept, CourseSource } from '@shared/course_pack.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';

export const SOURCE_LABELS: Record<CourseSource, string> = { builtin: '内置', repository: '仓库', user: '已导入' };
export const FROM_LABELS = { local: '本机设置', project: 'taskpilot.toml', default: '默认' } as const;
export const TRUST_LABELS: Record<courseTypes.CourseTrust, string> = { builtin: '内置', confirmed: '已确认', pending: '待确认', invalid: '有错误' };

export const FIELD_LABELS: Record<string, string> = {
  version: '版本',
  domain: '领域',
  title: '名称',
  summary: '简介',
  learner: '学习者',
  tutorGuide: '讲解指引',
  difficultyGuide: '难度指引',
  practiceGuide: '练习方式指引',
  referenceGuide: '参考答案指引',
  appliesTo: '适用语言',
  labGuide: 'lab 生成指引',
  rubric: '判卷维度的顺序',
  concepts: '知识点的顺序',
  label: '名称',
  description: '说明',
  dimension: '通用维度',
  examples: '示例',
};

// What a rubric item's or a concept's own fields are called in a change.
const LISTS: Record<string, { label: string; fields: Record<string, string> }> = {
  rubric: { label: '判卷维度', fields: FIELD_LABELS },
  concepts: { label: '知识点', fields: { label: '名称', summary: '说明', prerequisites: '前置知识点', dimension: '通用维度' } },
};

export const dimensionLabel = (dimension: string) => COURSE_DIMENSION_LABELS[dimension as keyof typeof COURSE_DIMENSION_LABELS] ?? dimension;

const KIND_LABELS: Record<CourseChange['kind'], string> = { added: '新增', removed: '删除', changed: '修改' };

// One change as a line, e.g. "修改 判卷维度 concept 的说明".
export const changeText = ({ field, kind }: CourseChange) => {
  const [head, item, key] = field.split('.');
  const list = LISTS[head];
  if (!list || item === undefined) return `${KIND_LABELS[kind]} ${FIELD_LABELS[field] ?? field}`;
  if (key === undefined) return `${KIND_LABELS[kind]} ${list.label} ${item}`;
  return `${KIND_LABELS[kind]} ${list.label} ${item} 的${list.fields[key] ?? key}`;
};

// Whether a rubric item or concept is marked: added, or one of its fields changed.
export const itemChanged = (marked: Set<string>, list: 'rubric' | 'concepts', id: string) =>
  [...marked].some((field) => field === `${list}.${id}` || field.startsWith(`${list}.${id}.`));

// The fields shown with a changed mark: `tutorGuide`, `rubric.<id>` (a new
// item) and `rubric.<id>.<field>`, and the same for `concepts`.
export const changedFields = (changes: CourseChange[]) => new Set(changes.filter((change) => change.kind !== 'removed').map((change) => change.field));

// The pack's languages when none of them is the repository's; null when
// there is nothing to warn about (the pack names none, or the repository's
// are unknown).
export const languageMismatch = (packLanguages: string[] | null | undefined, repositoryLanguages: string[]) => {
  if (!packLanguages?.length || repositoryLanguages.length === 0) return null;
  return packLanguages.some((language) => repositoryLanguages.includes(language)) ? null : packLanguages;
};

// Where a pack's file lives, for the preview.
export const sourcePath = (id: string, source: CourseSource, userDir: string) => {
  if (source === 'repository') return `.taskpilot/courses/${id}.toml`;
  return source === 'user' ? `${userDir}/${id}.toml` : null;
};

// The concept editor's checks, keyed like the main process's errors
// (`concepts[2].id`), so a field shows the same message before saving. The
// main process (../../../main/course_file.ts) still validates on save and
// has the final say; length and tag rules are left to it.
export const MAX_CONCEPTS = 200;
export const conceptErrors = (concepts: Concept[]): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (concepts.length > MAX_CONCEPTS) errors.concepts = `最多 ${MAX_CONCEPTS} 个知识点`;
  const seen = new Set<string>();
  const ids = new Set(concepts.map((item) => item.id));
  concepts.forEach((item, index) => {
    const at = `concepts[${index}]`;
    if (!isCourseId(item.id)) errors[`${at}.id`] = '小写字母开头，只用小写字母、数字、- 或 _，最长 32 个字符';
    else if (seen.has(item.id)) errors[`${at}.id`] = `和前面的知识点重复：${item.id}`;
    seen.add(item.id);
    if (!item.label.trim()) errors[`${at}.label`] = '名称不能为空';
    if (!item.summary.trim()) errors[`${at}.summary`] = '说明不能为空';
    const unknown = item.prerequisites.filter((id) => !ids.has(id));
    if (unknown.length) errors[`${at}.prerequisites`] = `不是本包的知识点：${unknown.join('、')}`;
  });
  const cycle = conceptCycle(concepts);
  if (cycle) errors[`concepts[${concepts.findIndex((item) => item.id === cycle[0])}].prerequisites`] = `前置关系成环：${cycle.join(' → ')}`;
  return errors;
};

// Pure helpers for the course pack page: how a pack's fields, sources and
// changes read, and whether a pack is written for the repository's
// languages. No DOM access, so tests import it directly.
import { COURSE_DIMENSION_LABELS } from '@shared/course_pack.ts';
import type { CourseChange } from '@shared/course_changes.ts';
import type { CourseSource } from '@shared/course_pack.ts';
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
  rubric: '判卷维度的顺序',
  label: '名称',
  description: '说明',
  dimension: '通用维度',
  examples: '示例',
};

export const dimensionLabel = (dimension: string) => COURSE_DIMENSION_LABELS[dimension as keyof typeof COURSE_DIMENSION_LABELS] ?? dimension;

const KIND_LABELS: Record<CourseChange['kind'], string> = { added: '新增', removed: '删除', changed: '修改' };

// One change as a line, e.g. "修改 判卷维度 concept 的说明".
export const changeText = ({ field, kind }: CourseChange) => {
  const [head, item, key] = field.split('.');
  if (head !== 'rubric' || item === undefined) return `${KIND_LABELS[kind]} ${FIELD_LABELS[field] ?? field}`;
  if (key === undefined) return `${KIND_LABELS[kind]} 判卷维度 ${item}`;
  return `${KIND_LABELS[kind]} 判卷维度 ${item} 的${FIELD_LABELS[key] ?? key}`;
};

// The fields shown with a changed mark: `tutorGuide`, `rubric.<id>` (a new
// item) and `rubric.<id>.<field>`.
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

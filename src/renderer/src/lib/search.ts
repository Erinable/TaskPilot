// Pure ranking for the command palette: work packages, requirements and
// settings pages, filtered in memory. No Vue or IPC, so tests call it directly.
import { needsAttention } from '@/components/requirements/requirement_model.ts';
import type * as ipc from '@shared/ipc_types.ts';
import type { SettingsPage } from './settings_model.ts';

export type SearchKind = 'task' | 'requirement' | 'setting';

export type SearchTarget = { kind: 'task'; id: string } | { kind: 'requirement'; id: string } | { kind: 'setting'; page: SettingsPage };

// One searchable row. `key` is unique across kinds (used for DOM ids).
// The *Text fields are lowercased once when the index is built.
export type SearchEntry = {
  key: string;
  kind: SearchKind;
  target: SearchTarget;
  title: string;
  detail: string;
  // Shown when the query is empty.
  featured: boolean;
  titleText: string;
  metaText: string;
  bodyText: string;
};

export type SearchGroup = { kind: SearchKind; label: string; entries: SearchEntry[] };

export const GROUP_LABELS: Record<SearchKind, string> = { task: '工作包', requirement: '需求', setting: '设置' };
const GROUP_ORDER: SearchKind[] = ['task', 'requirement', 'setting'];
export const GROUP_LIMIT = 8;
// Rows per group when the query is empty.
export const DEFAULT_LIMIT = 5;

// Field weights: title beats id/module/tags beats description/text.
const TITLE_WEIGHT = 100;
const TITLE_PREFIX_BONUS = 50;
const META_WEIGHT = 10;
const BODY_WEIGHT = 1;

export type SettingsNavEntry = { page: SettingsPage; label: string; keywords: string };

const lower = (text: string) => text.toLowerCase();

// A requirement without a title is named by its first line.
const requirementTitle = (item: Pick<ipc.Requirement, 'title' | 'text'>) => item.title.trim() || item.text.trim().split('\n')[0] || '未命名需求';

export const taskEntry = (task: Pick<ipc.TaskView, 'id' | 'title' | 'description' | 'module' | 'tags' | 'status' | 'statusLabel'>): SearchEntry => ({
  key: `task:${task.id}`,
  kind: 'task',
  target: { kind: 'task', id: task.id },
  title: task.title,
  detail: [task.id, task.module, task.statusLabel].filter(Boolean).join(' · '),
  featured: task.status !== 'done',
  titleText: lower(task.title),
  metaText: lower([task.id, task.module, ...task.tags].join(' ')),
  bodyText: lower(task.description),
});

export const requirementEntry = (item: Pick<ipc.Requirement, 'id' | 'title' | 'text' | 'status'>, statusLabel: string): SearchEntry => {
  const title = requirementTitle(item);
  return {
    key: `requirement:${item.id}`,
    kind: 'requirement',
    target: { kind: 'requirement', id: item.id },
    title,
    detail: statusLabel,
    featured: needsAttention(item),
    titleText: lower(title),
    metaText: lower(item.id),
    bodyText: lower(item.text),
  };
};

export const settingEntry = (entry: SettingsNavEntry): SearchEntry => ({
  key: `setting:${entry.page}`,
  kind: 'setting',
  target: { kind: 'setting', page: entry.page },
  title: entry.label,
  detail: '设置',
  featured: false,
  titleText: lower(entry.label),
  metaText: lower(`${entry.page} ${entry.keywords}`),
  bodyText: '',
});

export const queryTerms = (query: string) => lower(query).split(/\s+/).filter(Boolean);

// 0 when some term matches nowhere; otherwise higher is better.
export const scoreEntry = (entry: SearchEntry, terms: string[]) => {
  let score = 0;
  for (const term of terms) {
    if (entry.titleText.includes(term)) score += TITLE_WEIGHT + (entry.titleText.startsWith(term) ? TITLE_PREFIX_BONUS : 0);
    else if (entry.metaText.includes(term)) score += META_WEIGHT;
    else if (entry.bodyText.includes(term)) score += BODY_WEIGHT;
    else return 0;
  }
  return score;
};

// Groups in a fixed order, at most GROUP_LIMIT rows each, empty groups dropped.
// One pass over the index per query; ties keep the index order.
export const search = (entries: SearchEntry[], query: string): SearchGroup[] => {
  const terms = queryTerms(query);
  const buckets: Record<SearchKind, { entry: SearchEntry; score: number }[]> = { task: [], requirement: [], setting: [] };
  for (const entry of entries) {
    if (terms.length === 0) {
      if (entry.featured && buckets[entry.kind].length < DEFAULT_LIMIT) buckets[entry.kind].push({ entry, score: 0 });
      continue;
    }
    const score = scoreEntry(entry, terms);
    if (score > 0) buckets[entry.kind].push({ entry, score });
  }
  return GROUP_ORDER.map((kind) => ({
    kind,
    label: GROUP_LABELS[kind],
    entries: buckets[kind]
      .sort((a, b) => b.score - a.score)
      .slice(0, GROUP_LIMIT)
      .map((row) => row.entry),
  })).filter((group) => group.entries.length > 0);
};

// Next highlighted index in the flattened result list, wrapping around.
// With nothing highlighted, down starts at the top and up at the bottom.
export const moveHighlight = (index: number, delta: 1 | -1, count: number) => {
  if (count === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
};

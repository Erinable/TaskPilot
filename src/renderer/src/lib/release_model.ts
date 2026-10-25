// Release page wording and derivations. Pure: no IPC, no DOM.
import { businessTimeZone } from './time_zone.ts';
import type * as releaseTypes from '@shared/ipc/release.ts';

// How often the page re-reads the draft while Release Manager is writing it.
export const POLL_MS = 1200;

// History rows rendered before 显示更多.
export const HISTORY_PAGE = 20;

// Suggested paths for 写入文件…; the user may type any .md path.
export const NOTES_PATH_SUGGESTIONS = ['CHANGELOG.md', 'docs/CHANGELOG.md'];

export const BUMP_LABELS: Record<releaseTypes.ReleaseBump, string> = { major: '主版本', minor: '次版本', patch: '修订版本' };

const START_KIND_LABELS = { release: '上次发布', tag: '标签' } as const;

export const shortSha = (sha: string) => sha.slice(0, 7);

// 「从 上次发布 v1.2.0 开始（N 个提交，M 个完成的工作包）」. The start point's
// own preview counts come first; a draft's input is the fallback.
export const startPointLine = (startPoint: releaseTypes.ReleaseStartPoint & { kind: 'release' | 'tag' }, input: releaseTypes.ReleaseInputSummary | null) => {
  const from = `从${START_KIND_LABELS[startPoint.kind]} ${startPoint.label} 开始`;
  if (startPoint.commitCount !== undefined && startPoint.packageCount !== undefined) {
    return `${from}（${startPoint.commitCount}${startPoint.commitsTruncated ? '+' : ''} 个提交，${startPoint.packageCount} 个完成的工作包）`;
  }
  if (!input) return from;
  return `${from}（${input.commitCount}${input.commitsTruncated ? '+' : ''} 个提交，${input.packageIds.length} 个完成的工作包）`;
};

export const draftInputLine = (input: releaseTypes.ReleaseInputSummary) =>
  `${input.commitCount}${input.commitsTruncated ? '+' : ''} 个提交，${input.packageIds.length} 个完成的工作包`;

export const versionFrom = (plan: releaseTypes.ReleasePlan) => plan.currentVersion ?? '未发布';

// YYYY-MM-DD HH:mm:ss in the business time zone.
export const formatTime = (iso: string, timeZone = businessTimeZone()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

export const commitOptionLabel = (commit: releaseTypes.ReleaseCommit) => `${shortSha(commit.sha)} ${commit.subject} · ${formatTime(commit.date).slice(0, 10)}`;

export const allChecked = (draft: releaseTypes.ReleaseDraft) => !!draft.plan && draft.plan.checklist.every((_, index) => draft.checked.includes(index));

// The new checked list after toggling one item, sorted for a stable payload.
export const toggleChecked = (checked: number[], index: number, value: boolean) => {
  const rest = checked.filter((candidate) => candidate !== index);
  return (value ? [...rest, index] : rest).sort((left, right) => left - right);
};

export const isMarkdownPath = (path: string) => /\.md$/i.test(path.trim());

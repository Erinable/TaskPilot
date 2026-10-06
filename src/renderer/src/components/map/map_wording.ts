// Wording shared by the engineering map components.
import { businessDay } from '@/lib/time_zone.ts';
import type * as ipc from '@shared/ipc_types.ts';

// Tones reuse the .status-pill colour classes.
export const FRESHNESS: Record<ipc.MapFreshness, { label: string; tone: string }> = {
  current: { label: '最新', tone: 'done' },
  stale: { label: '可能过时（文件已改动）', tone: 'in_review' },
  removed: { label: '文件已删除', tone: 'deviation' },
  unknown: { label: '无法判断', tone: '' },
};

// YYYY-MM-DD in the business time zone when known, else the local one.
export const sourceDate = (at: string, timeZone: string) => businessDay(new Date(at), timeZone);

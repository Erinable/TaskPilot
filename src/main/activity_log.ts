// Append-only record of what happened to work packages and requirements,
// the source of the queue's metrics and the activity feed.
//
// One JSONL file per business day (events/YYYY-MM-DD.jsonl). Readers open only
// the days they need, so their work does not grow with history, and expired
// days are deleted whole on startup.
//
// [人工决策-2026-10-06 14:36:47] 事件按业务日分文件存 JSONL，保留 30 天；不用 SQLite（原生模块需为 Electron 重编译）。
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ActivityEvent, ActivityRecord, QueueMetrics } from '../shared/ipc_types.ts';

export const EVENTS_DIRNAME = 'events';
export const RETENTION_DAYS = 30;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// YYYY-MM-DD of `date` in the business time zone.
export const businessDay = (date: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// The `count` business days ending with the one `now` falls in, newest first.
// Stepping back 24h at a time from noon UTC stays on distinct calendar days
// in every zone, DST included, because offsets are under 15 hours.
export const recentDays = (now: Date, timeZone: string, count: number) => {
  const today = businessDay(now, timeZone);
  const noon = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_unused, index) => new Date(noon - index * DAY_MS).toISOString().slice(0, 10));
};

export class ActivityLog {
  #dir: string;
  #timeZone: string;
  #now: () => Date;
  // Appends are chained so lines from concurrent writers never interleave.
  #writes: Promise<void> = Promise.resolve();

  constructor(configDir: string, { timeZone, now = () => new Date() }: { timeZone: string; now?: () => Date }) {
    this.#dir = path.join(configDir, EVENTS_DIRNAME);
    this.#timeZone = timeZone;
    this.#now = now;
  }

  get timeZone() {
    return this.#timeZone;
  }

  // Records one event. Callers on the request path do not await it.
  append(event: ActivityEvent): Promise<void> {
    const at = this.#now();
    const record: ActivityRecord = { ...event, at: at.toISOString() };
    const file = path.join(this.#dir, `${businessDay(at, this.#timeZone)}.jsonl`);
    const write = this.#writes.then(async () => {
      await fs.mkdir(this.#dir, { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`);
    });
    this.#writes = write.catch(() => {});
    return write;
  }

  // Events from the last `days` business days, newest first, at most `limit`.
  async recent({ days, limit }: { days: number; limit: number }): Promise<ActivityRecord[]> {
    const records: ActivityRecord[] = [];
    for (const day of recentDays(this.#now(), this.#timeZone, days)) {
      const dayRecords = await this.#readDay(day);
      records.push(...dayRecords.reverse());
      if (records.length >= limit) break;
    }
    return records.slice(0, limit);
  }

  // One page of the full feed: whole business days, newest first, starting
  // at `before` (exclusive) and stopping once `minEvents` are collected or
  // the retention window ends. `nextBefore` continues from the last day read.
  async page({ before, minEvents }: { before: string | null; minEvents: number }): Promise<{ days: { day: string; records: ActivityRecord[] }[]; nextBefore: string | null }> {
    const window = recentDays(this.#now(), this.#timeZone, RETENTION_DAYS);
    const start = before ? window.findIndex((day) => day < before) : 0;
    if (start < 0) return { days: [], nextBefore: null };
    const days: { day: string; records: ActivityRecord[] }[] = [];
    let count = 0;
    let index = start;
    for (; index < window.length && count < minEvents; index += 1) {
      const records = (await this.#readDay(window[index])).reverse();
      if (records.length) days.push({ day: window[index], records });
      count += records.length;
    }
    return { days, nextBefore: index < window.length ? window[index - 1] : null };
  }

  // Every event from the last `days` business days, oldest first (metrics).
  async window(days: number): Promise<ActivityRecord[]> {
    const perDay = await Promise.all(recentDays(this.#now(), this.#timeZone, days).map((day) => this.#readDay(day)));
    return perDay.reverse().flat();
  }

  // Deletes day files older than the retention window.
  async prune(): Promise<string[]> {
    const keep = new Set(recentDays(this.#now(), this.#timeZone, RETENTION_DAYS));
    const oldest = [...keep].at(-1) as string;
    let names: string[];
    try {
      names = await fs.readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const expired = names.filter((name) => {
      const day = DAY_FILE.exec(name)?.[1];
      return day !== undefined && day < oldest;
    });
    await Promise.all(expired.map((name) => fs.rm(path.join(this.#dir, name), { force: true })));
    return expired;
  }

  async #readDay(day: string): Promise<ActivityRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.#dir, `${day}.jsonl`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // A line cut short by a crash mid-append is skipped, not fatal.
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line) as ActivityRecord;
        return typeof record?.kind === 'string' && typeof record.at === 'string' ? [record] : [];
      } catch {
        return [];
      }
    });
  }
}

const METRIC_DAYS = 7;

// Claim-to-done durations need the claim, which may be older than the week
// the package finished in; the whole retention window is scanned once.
export const computeMetrics = (records: ActivityRecord[], now: Date, timeZone: string): QueueMetrics => {
  const thisWeek = new Set(recentDays(now, timeZone, METRIC_DAYS));
  const previousWeek = new Set(recentDays(now, timeZone, METRIC_DAYS * 2).slice(METRIC_DAYS));
  const claimedAt = new Map<string, number>();
  const durations = { current: [] as number[], previous: [] as number[] };
  let doneThisWeek = 0;
  let donePreviousWeek = 0;
  for (const record of records) {
    if (record.kind !== 'package_transition') continue;
    if (record.transition === 'claim') claimedAt.set(record.packageId, Date.parse(record.at));
    if (record.transition === 'release') claimedAt.delete(record.packageId);
    if (record.to !== 'done') continue;
    const day = businessDay(new Date(record.at), timeZone);
    const bucket = thisWeek.has(day) ? 'current' : previousWeek.has(day) ? 'previous' : null;
    if (!bucket) continue;
    if (bucket === 'current') doneThisWeek += 1;
    else donePreviousWeek += 1;
    const start = claimedAt.get(record.packageId);
    if (start !== undefined) durations[bucket].push((Date.parse(record.at) - start) / 3_600_000);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  return { doneThisWeek, donePreviousWeek, averageHours: mean(durations.current), averageHoursPrevious: mean(durations.previous) };
};

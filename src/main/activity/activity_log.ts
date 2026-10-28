// Append-only record of what happened to work packages and requirements,
// the source of the queue's metrics, the activity feed and agent spend.
//
// One JSONL file per business day (events/YYYY-MM-DD.jsonl). Readers open only
// the days they need, so their work does not grow with history, and expired
// days are deleted whole on startup.
//
// [人工决策-2026-10-06 14:36:47] 事件按业务日分文件存 JSONL，保留 30 天；不用 SQLite（原生模块需为 Electron 重编译）。
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import type { ActivityEvent, ActivityRecord, CostSubject, ModelCall } from '../../shared/ipc/activity.ts';
import type { AgentId } from '../../shared/agent_runtime.ts';
import { foldCosts, mergeRollup, parseRollup, ROLLUP_DAYS, ROLLUP_FILENAME } from './cost_rollup.ts';
import type { CostRow } from './cost_rollup.ts';
import { readStoredJson, writeStoredJson, assertStorageVersion } from '../infrastructure/persisted_json.ts';
import { ActivitySummary } from './activity_summary.ts';
import type { StateChanged } from '../infrastructure/state_changes.ts';
import type { EstimateRow, OverviewSummary } from './activity_summary.ts';

// One model call's spend. Stored beside the feed events so it expires with
// them, but never shown in the feed: it is not something that happened.
// Lines from before 2026-10-13 have only agent and costUsd.
export type AgentCostEvent = { kind: 'agent_cost'; agent: AgentId; costUsd: number | null; call?: ModelCall; subject?: CostSubject };
export type LoggedEvent = ActivityEvent | AgentCostEvent;
export type LoggedRecord = LoggedEvent & { at: string; storageVersion?: number };

const isFeedRecord = (record: LoggedRecord): record is ActivityRecord => record.kind !== 'agent_cost';

export const EVENTS_DIRNAME = 'events';
export const RETENTION_DAYS = 30;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// YYYY-MM-DD of `date` in the business time zone.
export const businessDay = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

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
  #onChanged?: StateChanged;
  // Appends are chained so lines from concurrent writers never interleave.
  #writes: Promise<void> = Promise.resolve();
  // The overview's aggregates, built from the files on first use and then
  // kept current by every append that lands.
  #summary: ActivitySummary | null = null;
  #building: Promise<ActivitySummary> | null = null;

  setOnChanged(listener: StateChanged): void {
    this.#onChanged = listener;
  }

  #notify() {
    try {
      this.#onChanged?.('activity');
    } catch (error) {
      logger.error('[activity] change listener failed', error);
    }
  }

  constructor(configDir: string, { timeZone, now = () => new Date() }: { timeZone: string; now?: () => Date }) {
    this.#dir = path.join(configDir, EVENTS_DIRNAME);
    this.#timeZone = timeZone;
    this.#now = now;
  }

  get timeZone() {
    return this.#timeZone;
  }

  // Resolves once every append so far has landed.
  flush(): Promise<void> {
    return this.#writes;
  }

  // Rebinds the log to another data directory (a repository switch).
  async open(configDir: string): Promise<this> {
    await this.flush();
    this.#dir = path.join(configDir, EVENTS_DIRNAME);
    this.#summary = null;
    this.#building = null;
    return this;
  }

  // Records one event. Callers on the request path do not await it.
  append(event: LoggedEvent): Promise<void> {
    const at = this.#now();
    const record: LoggedRecord = { storageVersion: 1, ...event, at: at.toISOString() };
    const file = path.join(this.#dir, `${businessDay(at, this.#timeZone)}.jsonl`);
    const write = this.#writes.then(async () => {
      await fs.mkdir(this.#dir, { recursive: true });
      await this.#readDay(businessDay(at, this.#timeZone));
      await fs.appendFile(file, `${JSON.stringify(record)}\n`);
      this.#summary?.add(record);
      this.#notify();
    });
    this.#writes = write.catch(() => {});
    return write;
  }

  // Events from the last `days` business days, newest first, at most `limit`.
  async recent({ days, limit }: { days: number; limit: number }): Promise<ActivityRecord[]> {
    const records: ActivityRecord[] = [];
    for (const day of recentDays(this.#now(), this.#timeZone, days)) {
      const dayRecords = (await this.#readDay(day)).filter(isFeedRecord);
      records.push(...dayRecords.reverse());
      if (records.length >= limit) break;
    }
    return records.slice(0, limit);
  }

  // One page of the full feed: whole business days, newest first, starting
  // at `before` (exclusive) and stopping once `minEvents` are collected or
  // the retention window ends. `nextBefore` continues from the last day read.
  async page({
    before,
    minEvents,
  }: {
    before: string | null;
    minEvents: number;
  }): Promise<{ days: { day: string; records: ActivityRecord[] }[]; nextBefore: string | null }> {
    const window = recentDays(this.#now(), this.#timeZone, RETENTION_DAYS);
    const start = before ? window.findIndex((day) => day < before) : 0;
    if (start < 0) return { days: [], nextBefore: null };
    const days: { day: string; records: ActivityRecord[] }[] = [];
    let count = 0;
    let index = start;
    for (; index < window.length && count < minEvents; index += 1) {
      const records = (await this.#readDay(window[index])).filter(isFeedRecord).reverse();
      if (records.length) days.push({ day: window[index], records });
      count += records.length;
    }
    return { days, nextBefore: index < window.length ? window[index - 1] : null };
  }

  // Every record from the last `days` business days, oldest first (metrics and spend).
  async window(days: number): Promise<LoggedRecord[]> {
    const perDay = await Promise.all(recentDays(this.#now(), this.#timeZone, days).map((day) => this.#readDay(day)));
    return perDay.reverse().flat();
  }

  // The overview's feed, metrics, per-member events and spend, from memory.
  // `estimate` prices token-only spend with the current price table.
  async overview(estimate?: EstimateRow): Promise<OverviewSummary> {
    const summary = await (this.#building ??= this.#build());
    return summary.read(recentDays(this.#now(), this.#timeZone, RETENTION_DAYS), estimate);
  }

  // Reads the window once, queued behind the appends so far: every append
  // before it is in the files it reads, every one after it lands in memory.
  #build(): Promise<ActivitySummary> {
    const build = this.#writes.then(async () => {
      const summary = new ActivitySummary((at) => businessDay(new Date(at), this.#timeZone));
      for (const record of await this.window(RETENTION_DAYS)) summary.add(record);
      this.#summary = summary;
      logger.debug(`[activity] summary built dir=${this.#dir}`);
      return summary;
    });
    this.#writes = build.then(
      () => {},
      () => {},
    );
    // A failed read is retried on the next request instead of sticking.
    build.catch(() => {
      if (this.#building === build) this.#building = null;
    });
    return build;
  }

  // Deletes day files older than the retention window, after folding their
  // costs into the rollup (see cost_rollup.ts).
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
    if (!expired.length) return [];
    const days = expired.map((name) => (DAY_FILE.exec(name) as RegExpExecArray)[1]);
    const records = (await Promise.all(days.map((day) => this.#readDay(day)))).flat();
    const folded = foldCosts(records, (record) => businessDay(new Date(record.at), this.#timeZone));
    const rollupOldest = recentDays(this.#now(), this.#timeZone, ROLLUP_DAYS).at(-1) as string;
    // Written before the day files go: a crash in between folds them again,
    // and the merge replaces those days rather than adding to them.
    const rollup = mergeRollup(await this.rollup(), folded, days, rollupOldest);
    // Through a temp file: the day files it folds are deleted next, so a
    // half-written rollup could never be rebuilt.
    await writeStoredJson(path.join(this.#dir, ROLLUP_FILENAME), { version: 1, rows: rollup });
    await Promise.all(expired.map((name) => fs.rm(path.join(this.#dir, name), { force: true })));
    return expired;
  }

  // Daily cost rows of days already pruned, oldest first.
  async rollup(): Promise<CostRow[]> {
    try {
      return parseRollup(await readStoredJson(path.join(this.#dir, ROLLUP_FILENAME), 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async #readDay(day: string): Promise<LoggedRecord[]> {
    let text: string;
    const file = path.join(this.#dir, `${day}.jsonl`);
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line) as LoggedRecord;
        assertStorageVersion({ version: record?.storageVersion }, 1, file);
        return typeof record?.kind === 'string' && typeof record.at === 'string' ? [record] : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
        return [];
      }
    });
  }
}

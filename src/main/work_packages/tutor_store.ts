// Tutor answers, one per level of the hint ladder per work package step, in
// the repository's tutor.json. Each answer is keyed on the step's text as
// well as its index, so a replan that rewrites a step never shows help for
// the old wording. Answers are help text, not execution state: resetting
// progress leaves them, and which levels the developer opened is kept in
// the package's state (WorkPackageState.hints), not here.
//
// Records written before the ladder have no level. They load as L1 with the
// code L1 may not carry taken out, so an old answer never shows more than
// its level allows.
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { validateAnswer } from '../agents/tutor.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import { isHintLevel } from '../../shared/hint_ladder.ts';
import type { TutorAnswer } from '../agents/tutor.ts';
import type { StateChanged } from '../infrastructure/state_changes.ts';
import { JsonWriteQueue } from '../infrastructure/atomic_json_file.ts';

export const TUTOR_FILENAME = 'tutor.json';
// Packages kept; the oldest answers go first beyond this.
const MAX_PACKAGES = 200;

export interface TutorRecord {
  packageId: string;
  stepIndex: number;
  step: string;
  level: number;
  answer: TutorAnswer;
  // The output filter took code out of the answer.
  filtered: boolean;
  // Tutor wrote it, or it is the lab's pre-written hint (Tutor had failed).
  source: 'tutor' | 'lab';
  costUsd: number;
  createdAt: string;
}

const keyOf = (packageId: string, stepIndex: number, level: number) => `${packageId}#${stepIndex}#${level}`;

// A saved record as this version reads it; null when it cannot be used.
const upgrade = (record: Partial<TutorRecord> | null): TutorRecord | null => {
  if (typeof record?.packageId !== 'string' || !Number.isInteger(record.stepIndex) || typeof record.step !== 'string') return null;
  if (record.level !== undefined) return isHintLevel(record.level) ? (record as TutorRecord) : null;
  try {
    const { answer, filtered } = validateAnswer(record.answer, 1);
    return { ...(record as TutorRecord), level: 1, answer, filtered, source: 'tutor' };
  } catch (error) {
    logger.error('[tutor] dropped an unreadable saved answer', error);
    return null;
  }
};

export class TutorStore {
  #file: string;
  #records = new Map<string, TutorRecord>();
  #writes = new JsonWriteQueue();
  #onChanged?: StateChanged;

  setOnChanged(listener: StateChanged): void {
    this.#onChanged = listener;
  }

  #notify() {
    try {
      this.#onChanged?.('tutor');
    } catch (error) {
      logger.error('[tutor] change listener failed', error);
    }
  }
  constructor(configDir: string) {
    this.#file = path.join(configDir, TUTOR_FILENAME);
  }

  async load(): Promise<this> {
    try {
      const raw = await readStoredJson(this.#file, 1);
      const saved = raw && typeof raw === 'object' && !Array.isArray(raw) && 'version' in raw && 'records' in raw ? raw.records : raw;
      for (const item of (Array.isArray(saved) ? saved : []) as Partial<TutorRecord>[]) {
        const record = upgrade(item);
        if (record) this.#records.set(keyOf(record.packageId, record.stepIndex, record.level), record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this;
  }

  // Rebinds the store to another data directory (a repository switch).
  async open(configDir: string): Promise<this> {
    await this.flush();
    this.#file = path.join(configDir, TUTOR_FILENAME);
    this.#records = new Map();
    return this.load();
  }

  flush(): Promise<void> {
    return this.#writes.flush();
  }

  // The answer at this level of this step, if its text is unchanged since it was asked.
  get(packageId: string, stepIndex: number, step: string, level: number): TutorRecord | null {
    const record = this.#records.get(keyOf(packageId, stepIndex, level));
    return record && record.step === step ? structuredClone(record) : null;
  }

  async put(record: TutorRecord): Promise<TutorRecord> {
    this.#records.set(keyOf(record.packageId, record.stepIndex, record.level), record);
    // Bounded: drop whole packages, oldest answer first.
    const packages = [...new Set([...this.#records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => item.packageId))];
    for (const dropped of packages.slice(MAX_PACKAGES)) {
      for (const [key, item] of this.#records) if (item.packageId === dropped) this.#records.delete(key);
    }
    await this.#persist();
    return structuredClone(record);
  }

  #persist = async () => {
    await this.#writes.enqueue(() => writeStoredJson(this.#file, { version: 1, records: [...this.#records.values()] }));
    this.#notify();
  };
}

// Tutor answers, one per work package step, in the repository's tutor.json.
// Each answer is keyed on the step's text as well as its index, so a replan
// that rewrites a step never shows help for the old wording. Answers are
// help text, not execution state: resetting progress leaves them.
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TutorAnswer } from './agents/tutor.ts';

export const TUTOR_FILENAME = 'tutor.json';
// Packages kept; the oldest answers go first beyond this.
const MAX_PACKAGES = 200;

export interface TutorRecord {
  packageId: string;
  stepIndex: number;
  step: string;
  answer: TutorAnswer;
  costUsd: number;
  createdAt: string;
}

const keyOf = (packageId: string, stepIndex: number) => `${packageId}#${stepIndex}`;

export class TutorStore {
  #file: string;
  #records = new Map<string, TutorRecord>();
  #writes: Promise<void> = Promise.resolve();

  constructor(configDir: string) {
    this.#file = path.join(configDir, TUTOR_FILENAME);
  }

  async load(): Promise<this> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const record of (Array.isArray(saved) ? saved : []) as TutorRecord[]) {
        if (typeof record?.packageId !== 'string' || !Number.isInteger(record.stepIndex) || typeof record.step !== 'string') continue;
        this.#records.set(keyOf(record.packageId, record.stepIndex), record);
      }
    } catch (error) {
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
    return this.#writes;
  }

  // The answer for this step, if its text is unchanged since it was asked.
  get(packageId: string, stepIndex: number, step: string): TutorRecord | null {
    const record = this.#records.get(keyOf(packageId, stepIndex));
    return record && record.step === step ? structuredClone(record) : null;
  }

  async put(record: TutorRecord): Promise<TutorRecord> {
    this.#records.set(keyOf(record.packageId, record.stepIndex), record);
    // Bounded: drop whole packages, oldest answer first.
    const packages = [...new Set([...this.#records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => item.packageId))];
    for (const dropped of packages.slice(MAX_PACKAGES)) {
      for (const [key, item] of this.#records) if (item.packageId === dropped) this.#records.delete(key);
    }
    await this.#persist();
    return structuredClone(record);
  }

  #persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify([...this.#records.values()], null, 2)}\n`);
      await fs.rename(tmp, this.#file);
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}

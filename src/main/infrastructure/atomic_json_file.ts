// The one way TaskPilot replaces a file on disk: written whole to a temp file,
// then renamed over the target, so a crash mid-write leaves the previous file.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type AtomicOptions = { tmp?: string; mode?: number };

// tmp defaults to a unique `<file>.<uuid>.tmp` beside the target, so writers
// that replace the same file at once never share a temp file; the last rename
// wins. A failed write removes its temp file.
export const writeFileAtomic = async (file: string, content: string, { tmp = `${file}.${randomUUID()}.tmp`, mode }: AtomicOptions = {}) => {
  try {
    await fs.writeFile(tmp, content, mode === undefined ? undefined : { mode });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Writes a store's JSON file one at a time, so a background run saving at the
// same moment as a user edit lands in order and the file ends as the latest.
export class JsonWriteQueue {
  #writes: Promise<void> = Promise.resolve();

  // The snapshot is taken when the write runs, not when it is queued, so the
  // file always reflects the latest state, at the store's current path.
  write(snapshot: () => { file: string; value: unknown }): Promise<void> {
    return this.enqueue(async () => {
      const { file, value } = snapshot();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, jsonText(value));
    });
  }

  // Versioned stores supply their guarded writer without losing serialization
  // or flush semantics; the operation reads its snapshot only when scheduled.
  enqueue(operation: () => Promise<void>): Promise<void> {
    const write = this.#writes.then(operation);
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.#writes = write.catch(() => {});
    return write;
  }

  // Resolves once every write so far has landed.
  flush(): Promise<void> {
    return this.#writes;
  }
}

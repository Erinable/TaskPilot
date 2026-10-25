// The one way TaskPilot replaces a file on disk: written whole to a temp file,
// then renamed over the target, so a crash mid-write leaves the previous file.
import fs from 'node:fs/promises';
import path from 'node:path';

type AtomicOptions = { tmp?: string; mode?: number };

// tmp defaults to `<file>.tmp`; callers that may write the same file at once
// pass a unique one, or go through a JsonWriteQueue.
export const writeFileAtomic = async (file: string, content: string, { tmp = `${file}.tmp`, mode }: AtomicOptions = {}) => {
  await fs.writeFile(tmp, content, mode === undefined ? undefined : { mode });
  await fs.rename(tmp, file);
};

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Writes a store's JSON file one at a time. Without the chain, a background
// run saving at the same moment as a user edit would share the temp file and
// one rename would fail.
export class JsonWriteQueue {
  #writes: Promise<void> = Promise.resolve();

  // The snapshot is taken when the write runs, not when it is queued, so the
  // file always reflects the latest state, at the store's current path.
  write(snapshot: () => { file: string; value: unknown }): Promise<void> {
    const write = this.#writes.then(async () => {
      const { file, value } = snapshot();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, jsonText(value));
    });
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.#writes = write.catch(() => {});
    return write;
  }

  // Resolves once every write so far has landed.
  flush(): Promise<void> {
    return this.#writes;
  }
}

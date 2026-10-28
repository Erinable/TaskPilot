import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { onTestFinished } from 'vitest';

export const tempDir = async (prefix: string): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
};

// Shared guarded persistence for application-owned JSON files.
// Legacy files without a version are accepted as version 1. Before replacing an
// existing file, writes inspect it so a future format can never be destroyed.
// The check is made once per path: a read or write that saw the file's version
// remembers it, so later writes of that version or newer skip the reread.
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic, jsonText } from './atomic_json_file.ts';
import { codedError } from './coded_error.ts';

export type StoredJsonWriteOptions = { mode?: number };

type Versioned = { version?: unknown };

// The version each path was last read or written with in this process.
const knownVersions = new Map<string, number>();

const unsupported = (file: string, detail: string): Error => codedError(`Unsupported storage version in ${file}: ${detail}`, 'unsupported_version');

export const assertStorageVersion = (value: unknown, supported: number, file: string): number => {
  const version = value && typeof value === 'object' && !Array.isArray(value) ? (value as Versioned).version : undefined;
  if (version === undefined) return 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > supported) throw unsupported(file, String(version));
  return version;
};

export const readStoredJson = async (file: string, supported = 1): Promise<unknown> => {
  const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  knownVersions.set(path.resolve(file), assertStorageVersion(value, supported, file));
  return value;
};

export const writeStoredJson = async (file: string, value: unknown, { mode }: StoredJsonWriteOptions = {}): Promise<void> => {
  const supplied = value && typeof value === 'object' && !Array.isArray(value) ? (value as Versioned).version : undefined;
  if (!Number.isInteger(supplied) || (supplied as number) < 1) throw unsupported(file, String(supplied));
  const supported = supplied as number;
  const key = path.resolve(file);
  const known = knownVersions.get(key);
  if (known === undefined || known > supported) {
    try {
      const existing = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      // Existing unversioned files are legacy v1 and may be replaced. A malformed
      // JSON file is likewise recoverable, matching each store's old behavior.
      assertStorageVersion(existing, supported, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, jsonText(value), { mode });
  knownVersions.set(key, supported);
};

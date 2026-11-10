// Shared guarded persistence for application-owned JSON files.
// Legacy files without a version are accepted as version 1. Every replacement
// checks the file on disk, including changes made after the store was loaded.
// Corrupt files remain untouched so the user can recover them before retrying.
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic, jsonText } from './atomic_json_file.ts';
import { codedError } from './coded_error.ts';

export type StoredJsonWriteOptions = { mode?: number };

type Versioned = { version?: unknown };

const unsupported = (file: string, detail: string): Error => codedError(`Unsupported storage version in ${file}: ${detail}`, 'unsupported_version');

export const assertStorageVersion = (value: unknown, supported: number, file: string): number => {
  const version = value && typeof value === 'object' && !Array.isArray(value) ? (value as Versioned).version : undefined;
  if (version === undefined) return 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > supported) throw unsupported(file, String(version));
  return version;
};

export const readStoredJson = async (file: string, supported = 1): Promise<unknown> => {
  const text = await fs.readFile(file, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw codedError(
      `应用数据文件已损坏，已停止读取或覆盖，原文件保持不变：${path.resolve(file)}。请先复制原文件留存，再从有效备份恢复或修复 JSON，完成后点击「重试」。请勿删除原文件或重置进度。`,
      'storage_corrupt',
    );
  }
  assertStorageVersion(value, supported, file);
  return value;
};

export const writeStoredJson = async (file: string, value: unknown, { mode }: StoredJsonWriteOptions = {}): Promise<void> => {
  const supplied = value && typeof value === 'object' && !Array.isArray(value) ? (value as Versioned).version : undefined;
  if (!Number.isInteger(supplied) || (supplied as number) < 1) throw unsupported(file, String(supplied));
  try {
    await readStoredJson(file, supplied as number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, jsonText(value), { mode });
};

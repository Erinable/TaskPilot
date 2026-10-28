// Three-way application of a Coding Agent patch onto a working tree the
// developer may have edited since the round started.
//
// Every merge is first done in a private git index (GIT_INDEX_FILE) seeded
// from HEAD plus the working-tree content of the patched file, so the real
// index, refs and working tree are untouched until the chosen outcomes are
// written. Each file is merged on its own: one conflict never blocks the rest.
// The merge base is the round's baseline commit (snapshotBaseline), whose
// blobs are in the repository, so `git apply --3way` can find them.
//
// [人工决策-2026-10-24 08:23:29] 冲突处理选方案 1：先预演，干净合并的文件照常写入；冲突文件由开发者逐个选「写入冲突标记 / 保留我的 / 用 AI 的」，用 AI 的要二次确认；写入冲突标记后自动检查和提交 QA 暂停，直到标记被清掉；自动重试轮遇到冲突一律停下等人。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { safeChildEnv } from './coding_process.ts';
import { GIT_PATH } from './coding_sandbox.ts';
import type { CodingMergeFile, CodingResolution } from '../../shared/coding_types.ts';

const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
// What `git merge-file` writes around each conflict.
export const CONFLICT_LABELS = { ours: '你的改动', base: '原来', theirs: 'Coding Agent' } as const;
const MARKER = /^(?:<{7} |={7}$|>{7} )/m;

export type PatchMergeErrorCode = 'merge_unresolved' | 'merge_cannot_apply' | 'merge_failed';
export class PatchMergeError extends Error {
  readonly code: PatchMergeErrorCode;
  readonly stderr: string;
  constructor(message: string, code: PatchMergeErrorCode, stderr = '') {
    super(message);
    this.name = 'PatchMergeError';
    this.code = code;
    this.stderr = stderr;
  }
}

// One file's part of the patch, cut at its `diff --git` header.
export type FilePatch = { path: string; patch: string };
export type Resolution = CodingResolution;

type GitResult = { code: number; stdout: Buffer; stderr: string };

// git in `root`, optionally with a private index. Never throws on a non-zero
// exit; output stays as bytes so binary blobs survive.
const runGit = (root: string, args: string[], { index, input }: { index?: string; input?: string } = {}) =>
  new Promise<GitResult>((resolve, reject) => {
    const env = { ...safeChildEnv(), ...(index ? { GIT_INDEX_FILE: index } : {}) };
    const child = execFile(
      GIT_PATH,
      ['-C', root, ...args],
      { env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        if (code === null) return reject(new PatchMergeError(`git ${args[0]} could not run`, 'merge_failed', String(error?.message ?? '')));
        resolve({ code, stdout, stderr: stderr.toString('utf8').slice(0, 64 * 1024) });
      },
    );
    // git may exit before reading all of stdin (a patch it rejects early);
    // the write then fails with EPIPE, and the exit code already says why.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

const must = async (result: Promise<GitResult>, what: string) => {
  const done = await result;
  if (done.code !== 0) throw new PatchMergeError(`git ${what} failed`, 'merge_failed', done.stderr);
  return done.stdout;
};

const withScratch = async <T>(work: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-merge-'));
  try {
    return await work(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

// Stage entries of one path in a private index: stage number → [mode, object].
const stagesOf = async (root: string, index: string, filePath: string) => {
  const listing = (await must(runGit(root, ['ls-files', '-s', '-z', '--', filePath], { index }), 'ls-files')).toString('utf8');
  const stages = new Map<number, { mode: string; object: string }>();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const [info] = entry.split('\t');
    const [mode, object, stage] = info.split(' ');
    stages.set(Number(stage), { mode, object });
  }
  return stages;
};

const blob = async (root: string, object: string) => must(runGit(root, ['cat-file', 'blob', object]), 'cat-file');

type Attempt = { state: 'clean' | 'merged'; entry: { mode: string; object: string } | null } | { state: 'conflict'; markers: Buffer | null };

// Whether the developer's file differs from the round baseline: its object
// id now (null when deleted) against the baseline's (null when absent).
const changedSince = async (root: string, baseline: string, filePath: string) => {
  const before = await runGit(root, ['rev-parse', '--verify', '--quiet', `${baseline}:${filePath}`]);
  const was = before.code === 0 ? before.stdout.toString('utf8').trim() : null;
  const exists = await fs.lstat(path.join(root, filePath)).catch(() => null);
  const now = exists ? (await must(runGit(root, ['hash-object', '--', filePath]), 'hash-object')).toString('utf8').trim() : null;
  return was !== now;
};

// Merges one file in a private index and reports what would land on disk.
// `merged` means the developer changed the file too; git can still apply
// that directly when the edits are far apart.
const attempt = async (root: string, directory: string, position: number, baseline: string, file: FilePatch): Promise<Attempt> => {
  const index = path.join(directory, `index-${position}`);
  await must(runGit(root, ['read-tree', 'HEAD'], { index }), 'read-tree');
  // The developer's current file, or its removal; a path new to both sides adds nothing.
  await must(runGit(root, ['update-index', '--add', '--remove', '--', file.path], { index }), 'update-index');
  const staged = async () => (await stagesOf(root, index, file.path)).get(0) ?? null;
  const landed = async () => ({ state: (await changedSince(root, baseline, file.path)) ? ('merged' as const) : ('clean' as const), entry: await staged() });
  if ((await runGit(root, ['apply', '--cached', '--binary'], { index, input: file.patch })).code === 0) return landed();
  const threeWay = await runGit(root, ['apply', '--3way', '--cached', '--binary'], { index, input: file.patch });
  if (threeWay.code === 0) return landed();
  const stages = await stagesOf(root, index, file.path);
  const ours = stages.get(2);
  const theirs = stages.get(3);
  // No stages: git could not stage it at all (deleted on one side, edited on
  // the other). There is no text to mark; only "mine" or "theirs" apply.
  if (!ours || !theirs) return { state: 'conflict', markers: null };
  const files = ['ours', 'base', 'theirs'].map((name) => path.join(directory, `${name}-${position}`));
  const base = stages.get(1);
  await fs.writeFile(files[0], await blob(root, ours.object));
  await fs.writeFile(files[1], base ? await blob(root, base.object) : Buffer.alloc(0));
  await fs.writeFile(files[2], await blob(root, theirs.object));
  const merged = await runGit(root, ['merge-file', '-p', '-L', CONFLICT_LABELS.ours, '-L', CONFLICT_LABELS.base, '-L', CONFLICT_LABELS.theirs, ...files]);
  // merge-file exits with the conflict count, or 255 when it refuses (binary).
  const text = merged.stdout.includes(0) ? '' : merged.stdout.toString('utf8');
  return { state: 'conflict', markers: merged.code > 0 && merged.code < 128 && MARKER.test(text) ? merged.stdout : null };
};

// How each file would land on the working tree now.
export const previewMerge = async (root: string, baseline: string, files: readonly FilePatch[]): Promise<CodingMergeFile[]> =>
  withScratch(async (directory) => {
    const results: CodingMergeFile[] = [];
    for (const [position, file] of files.entries()) {
      const outcome = await attempt(root, directory, position, baseline, file);
      results.push({ path: file.path, state: outcome.state, markers: outcome.state === 'conflict' && outcome.markers !== null });
    }
    return results;
  });

// What the renderer confirms: the patch, and how it merges right now. Any edit
// to a patched file between preview and apply changes it.
export const mergeDigest = (patch: string, merge: readonly CodingMergeFile[]) =>
  createHash('sha256')
    .update(patch)
    .update(JSON.stringify(merge.map((file) => [file.path, file.state, file.markers])))
    .digest('hex');

// The agent's version of one file: the patch applied to the round's baseline.
const theirsOf = async (root: string, directory: string, position: number, baseline: string, file: FilePatch) => {
  const index = path.join(directory, `theirs-${position}`);
  await must(runGit(root, ['read-tree', baseline], { index }), 'read-tree');
  await must(runGit(root, ['apply', '--cached', '--binary'], { index, input: file.patch }), 'apply');
  return (await stagesOf(root, index, file.path)).get(0) ?? null;
};

type Write = { path: string; content: Buffer | null; mode: string | null };

// Writes the chosen outcome of each file into the working tree, and nothing
// else. Clean and merged files take the merge. A conflict takes the
// developer's choice: `markers` writes the text with conflict markers,
// `mine` leaves the file as it is, `theirs` replaces it with the agent's
// version. Every outcome is computed before the first write. The real index
// is never touched.
export const applyMerged = async (
  root: string,
  baseline: string,
  files: readonly FilePatch[],
  resolutions: Readonly<Partial<Record<string, CodingResolution>>>,
): Promise<{ written: string[]; markers: string[]; kept: string[] }> =>
  withScratch(async (directory) => {
    const writes: Write[] = [];
    const markers: string[] = [];
    const kept: string[] = [];
    for (const [position, file] of files.entries()) {
      const outcome = await attempt(root, directory, position, baseline, file);
      if (outcome.state !== 'conflict') {
        writes.push({ path: file.path, content: outcome.entry ? await blob(root, outcome.entry.object) : null, mode: outcome.entry?.mode ?? null });
        continue;
      }
      const choice = resolutions[file.path];
      if (choice === 'mine') {
        kept.push(file.path);
        continue;
      }
      if (choice === 'markers') {
        if (!outcome.markers) throw new PatchMergeError(`${file.path} cannot be shown with conflict markers`, 'merge_cannot_apply');
        writes.push({ path: file.path, content: outcome.markers, mode: null });
        markers.push(file.path);
        continue;
      }
      if (choice === 'theirs') {
        const entry = await theirsOf(root, directory, position, baseline, file).catch(() => {
          throw new PatchMergeError(`${file.path}: the agent's version cannot be rebuilt`, 'merge_cannot_apply');
        });
        writes.push({ path: file.path, content: entry ? await blob(root, entry.object) : null, mode: entry?.mode ?? null });
        continue;
      }
      throw new PatchMergeError(`${file.path} has a conflict that needs a choice`, 'merge_unresolved');
    }
    for (const write of writes) {
      const target = path.join(root, write.path);
      if (write.content === null) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, write.content);
      if (write.mode === '100755') await fs.chmod(target, 0o755);
      else if (write.mode === '100644') await fs.chmod(target, 0o644);
    }
    return { written: writes.map((write) => write.path), markers, kept };
  });

// The patched files that still hold conflict markers.
export const filesWithMarkers = async (root: string, paths: readonly string[]): Promise<string[]> => {
  const found: string[] = [];
  for (const filePath of paths) {
    const content = await fs.readFile(path.join(root, filePath), 'utf8').catch(() => null);
    if (content !== null && MARKER.test(content)) found.push(filePath);
  }
  return found;
};

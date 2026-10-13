import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CodingPatchFile, CodingPatchPreview } from '../shared/coding_types.ts';
import { looksSecret } from './repo_reader.ts';
import type { CheckKind, Check } from './workspace.ts';
import * as verification from './verification.ts';
import * as testReport from './test_report.ts';
import { CODING_USER, CODING_WRAPPER_PATH, SUDO_PATH, safeChildEnv } from './coding_exec.ts';

export const GIT_PATH = '/usr/bin/git';
export const DEFAULT_RUN_ROOT = '/Users/taskpilot-coder/TaskPilotRuns';
export const MAX_PATCH_BYTES = 32 * 1024 * 1024;

export type WorkspaceErrorCode =
  | 'workspace_spawn_failed'
  | 'workspace_process_failed'
  | 'workspace_aborted'
  | 'workspace_invalid_run_name'
  | 'workspace_invalid_patch'
  | 'workspace_digest_mismatch'
  | 'workspace_blocked_patch'
  | 'workspace_out_of_scope';

export class CodingWorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly stderr: string;

  constructor(message: string, code: WorkspaceErrorCode, stderr = '') {
    super(message);
    this.name = 'CodingWorkspaceError';
    this.code = code;
    this.stderr = stderr;
  }
}

type WritableInput = {
  end: (chunk?: string | Uint8Array) => void;
  once?: (event: string, listener: (error: Error) => void) => unknown;
};
type ReadableOutput = { on: (event: string, listener: (chunk: unknown) => void) => unknown; pipe?: (target: WritableInput) => unknown };
type Child = {
  stdin: WritableInput;
  stdout: ReadableOutput;
  stderr: ReadableOutput;
  once: {
    (event: 'error', listener: (error: Error) => void): unknown;
    (event: 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  };
  kill?: (signal?: NodeJS.Signals) => boolean;
};
export type WorkspaceSpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => Child;
export type WorkspaceExecFn = (command: string, args: readonly string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

export interface WorkspaceOptions {
  runRoot?: string;
  spawnFn?: WorkspaceSpawnFn;
  runName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PreparedCodingWorkspace {
  runName: string;
  directory: string;
}

export type FileScope = readonly string[] | ReadonlySet<string> | ((filePath: string) => boolean) | undefined;
export type BlockedPatch = CodingPatchPreview['blocked'][number];

const execFileAsync = promisify(execFile);
const defaultSpawn: WorkspaceSpawnFn = (command, args, options) => nodeSpawn(command, [...args], options as never) as unknown as Child;
const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const highRiskName =
  /^(?:\.git(?:\/|$)|\.hooks(?:\/|$)|package\.json$|package-lock\.json$|npm-shrinkwrap\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.npmrc$|(?:test|tests|spec|__tests__|build|dist)(?:[./]|\/|$)|(?:Makefile|makefile|make\.bat)$|(?:\.github|\.gitlab|\.circleci)(?:\/|$))/i;
const secretName = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|(?:id|identity)_rsa(?:\.pub)?$|.*\.(?:pem|key|p12|pfx)$|credentials?(?:\.|\/|$))/i;
const forbiddenMode = /(?:^|\s)(?:new file mode|old mode) (?:120000|160000)\s*$/m;
const resolveRunName = (runName: string, runRoot: string): string => {
  if (safeName.test(runName)) return path.join(runRoot, runName);
  return runName;
};

const normalizePath = (value: string): string => value.replaceAll('\\', '/');

const pathReason = (value: string): string | null => {
  const normalized = normalizePath(value);
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) return 'absolute or empty path';
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return 'path traversal';
  if (parts[0].startsWith('.git')) return 'git metadata path';
  return null;
};

const inScope = (filePath: string, scope: FileScope): boolean => {
  if (!scope) return true;
  if (typeof scope === 'function') return scope(filePath);
  if ('has' in scope) return scope.has(filePath);
  return scope.includes(filePath);
};

const parseGitPath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};
const splitGitHeader = (value: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      current += value[index + 1];
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (/\s/.test(character) && !quoted) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else current += character;
  }
  if (current) parts.push(current);
  return parts;
};

const parsePatchFiles = (patch: string, fileScope: FileScope): { files: CodingPatchFile[]; blocked: BlockedPatch[] } => {
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new CodingWorkspaceError('Patch exceeds the size limit', 'workspace_invalid_patch');
  const files: CodingPatchFile[] = [];
  const blocked: BlockedPatch[] = [];
  const lines = patch.split('\n');
  let current: CodingPatchFile | undefined;
  let modeRisk = false;
  const finish = () => {
    if (!current) return;
    if (modeRisk) {
      current.highRisk = true;
      blocked.push({ path: current.path, reason: 'symlink or submodule mode is not permitted' });
    }
    if (highRiskName.test(current.path)) {
      current.highRisk = true;
      blocked.push({ path: current.path, reason: 'high-risk project control or test path' });
    }
    if (secretName.test(current.path)) blocked.push({ path: current.path, reason: 'secret path' });
    if (!inScope(current.path, fileScope)) blocked.push({ path: current.path, reason: 'outside requested file scope' });
    files.push(current);
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finish();
      const parts = splitGitHeader(line.slice('diff --git '.length));
      if (parts.length !== 2) throw new CodingWorkspaceError('Malformed git patch header', 'workspace_invalid_patch');
      const oldPath = parseGitPath(parts[0].replace(/^a\//, ''));
      const newPath = parseGitPath(parts[1].replace(/^b\//, ''));
      if (oldPath !== '/dev/null') {
        const oldReason = pathReason(oldPath);
        if (oldReason) blocked.push({ path: oldPath, reason: oldReason });
        if (!inScope(oldPath, fileScope)) blocked.push({ path: oldPath, reason: 'outside requested file scope' });
      }
      if (newPath !== '/dev/null') {
        const newReason = pathReason(newPath);
        if (newReason) blocked.push({ path: newPath, reason: newReason });
        if (!inScope(newPath, fileScope)) blocked.push({ path: newPath, reason: 'outside requested file scope' });
      }
      const candidate = newPath === '/dev/null' ? oldPath : newPath;
      const reason = pathReason(candidate);
      if (reason) blocked.push({ path: candidate, reason });
      current = { path: candidate, added: 0, removed: 0, binary: false, highRisk: false };
      modeRisk = false;
    } else if (current && /^\+[^+]/.test(line)) current.added += 1;
    else if (current && /^-[^-]/.test(line)) current.removed += 1;
    else if (current && /^Binary files /.test(line)) current.binary = true;
    else if (current && forbiddenMode.test(line)) modeRisk = true;
  }
  finish();
  if (!files.length && patch.trim()) throw new CodingWorkspaceError('Patch contains no file entries', 'workspace_invalid_patch');
  return { files, blocked };
};

const runWrapper = async (
  action: string,
  runName: string,
  options: WorkspaceOptions,
  input?: string,
  actionArgs: readonly string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const runRoot = options.runRoot ?? DEFAULT_RUN_ROOT;
  const resolvedRunName = resolveRunName(runName, runRoot);
  if (!safeName.test(path.basename(resolvedRunName)) || path.dirname(resolvedRunName) !== runRoot)
    throw new CodingWorkspaceError('Invalid coding run directory', 'workspace_invalid_run_name');
  if (options.signal?.aborted) throw new CodingWorkspaceError('Coding workspace action was cancelled', 'workspace_aborted');
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const args = ['-n', '-H', '-u', CODING_USER, CODING_WRAPPER_PATH, action, resolvedRunName, ...actionArgs];
  const child = (() => {
    try {
      return spawnFn(SUDO_PATH, args, { env: safeChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (caught) {
      throw new CodingWorkspaceError('Could not start coding workspace wrapper', 'workspace_spawn_failed', String(caught));
    }
  })();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stdout) < MAX_PATCH_BYTES) stdout += String(chunk).slice(0, MAX_PATCH_BYTES - Buffer.byteLength(stdout));
  });
  child.stderr.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stderr) < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - Buffer.byteLength(stderr));
  });
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  let settled = false;
  let termination: CodingWorkspaceError | null = null;
  let escalation: NodeJS.Timeout | undefined;
  const terminate = (error: CodingWorkspaceError) => {
    if (termination) return;
    termination = error;
    try {
      child.stdin.end();
    } catch {
      /* stream may already be closed */
    }
    child.kill?.('SIGTERM');
    escalation = setTimeout(() => child.kill?.('SIGKILL'), 1_000);
    escalation.unref?.();
  };
  const finish = (error?: CodingWorkspaceError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(escalation);
    options.signal?.removeEventListener('abort', abortListener);
    if (error) reject(error);
    else resolve({ stdout, stderr, exitCode: 0 });
  };
  const abortListener = () => terminate(new CodingWorkspaceError('Coding workspace action was cancelled', 'workspace_aborted'));
  options.signal?.addEventListener('abort', abortListener, { once: true });
  child.once('error', (error) => terminate(new CodingWorkspaceError('Coding wrapper failed to start', 'workspace_spawn_failed', error.message)));
  child.once('close', (code) => {
    if (termination) {
      finish(termination);
      return;
    }
    if (code !== 0 && action !== 'check') finish(new CodingWorkspaceError(`Coding wrapper ${action} failed`, 'workspace_process_failed', stderr));
    else {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortListener);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    }
  });
  const timer = setTimeout(
    () => terminate(new CodingWorkspaceError(`Coding wrapper ${action} timed out`, 'workspace_process_failed')),
    options.timeoutMs ?? 30_000,
  );
  timer.unref?.();
  try {
    child.stdin.end(input);
  } catch (caught) {
    terminate(new CodingWorkspaceError('Could not close coding wrapper stdin', 'workspace_process_failed', String(caught)));
  }
  return promise;
};

const runGitArchive = async (root: string, baseline: string, runName: string, options: WorkspaceOptions): Promise<void> => {
  if (options.signal?.aborted) throw new CodingWorkspaceError('Coding workspace preparation was cancelled', 'workspace_aborted');
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const git = spawnFn(GIT_PATH, ['-C', root, 'archive', '--format=tar', baseline], { env: safeChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const extract = spawnFn(SUDO_PATH, ['-n', '-H', '-u', CODING_USER, CODING_WRAPPER_PATH, 'extract', runName], {
    env: safeChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let archiveBytes = 0;
  git.stdout.on('data', (chunk: unknown) => {
    archiveBytes += Buffer.byteLength(chunk as string | Uint8Array);
    if (archiveBytes > MAX_PATCH_BYTES) {
      git.kill?.('SIGTERM');
      extract.kill?.('SIGTERM');
    }
  });
  git.stderr.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stderr) < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - Buffer.byteLength(stderr));
  });
  extract.stderr.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stderr) < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - Buffer.byteLength(stderr));
  });
  if (git.stdout.pipe) git.stdout.pipe(extract.stdin);
  else {
    git.stdout.on('data', (chunk: unknown) => extract.stdin.end(chunk as Uint8Array));
    git.once('close', () => extract.stdin.end());
  }
  const wait = (child: Child): Promise<number> => {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    child.once('error', (error) => reject(new CodingWorkspaceError('Archive process failed to start', 'workspace_spawn_failed', error.message)));
    child.once('close', (code) => resolve(code ?? 1));
    return promise;
  };
  const abort = () => {
    git.kill?.('SIGTERM');
    extract.kill?.('SIGTERM');
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    git.kill?.('SIGTERM');
    extract.kill?.('SIGTERM');
  }, options.timeoutMs ?? 30_000);
  timeout.unref?.();
  try {
    const statuses = await Promise.all([wait(git), wait(extract)]);
    if (options.signal?.aborted) throw new CodingWorkspaceError('Coding workspace preparation was cancelled', 'workspace_aborted');
    if (timedOut) throw new CodingWorkspaceError('Baseline archive or extraction timed out', 'workspace_process_failed', stderr);
    if (statuses[0] !== 0 || statuses[1] !== 0) throw new CodingWorkspaceError('Baseline archive or extraction failed', 'workspace_process_failed', stderr);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
};

export const prepare = async (root: string, baseline: string, options: WorkspaceOptions = {}): Promise<PreparedCodingWorkspace> => {
  const runRoot = options.runRoot ?? DEFAULT_RUN_ROOT;
  const runName = options.runName ? resolveRunName(options.runName, runRoot) : path.join(runRoot, randomUUID());
  if (!safeName.test(path.basename(runName)) || path.dirname(runName) !== runRoot)
    throw new CodingWorkspaceError('Invalid coding run directory', 'workspace_invalid_run_name');
  await runWrapper('mkdir', runName, options);
  try {
    await runGitArchive(root, baseline, runName, options);
    await runWrapper('init', runName, options);
    return { runName, directory: runName };
  } catch (error) {
    try {
      await runWrapper('clean', runName, { ...options, signal: undefined });
    } catch {
      /* Preserve preparation failure. */
    }
    throw error;
  }
};

export const readPatch = async (runName: string, fileScope?: FileScope, options: WorkspaceOptions = {}): Promise<CodingPatchPreview> => {
  const result = await runWrapper('diff', runName, options);
  const parsed = parsePatchFiles(result.stdout, fileScope);
  const digest = createHash('sha256').update(result.stdout).digest('hex');
  return { digest, files: parsed.files, patch: result.stdout, blocked: parsed.blocked };
};
export const runCheck = async (runName: string, kind: CheckKind, check: Check, options: WorkspaceOptions = {}): Promise<verification.CheckRun> => {
  if (!safeName.test(path.basename(resolveRunName(runName, options.runRoot ?? DEFAULT_RUN_ROOT))))
    throw new CodingWorkspaceError('Invalid coding run directory', 'workspace_invalid_run_name');
  if (check.command.includes('\n') || check.command.includes('\r') || check.args.some((argument) => argument.includes('\n') || argument.includes('\r')))
    throw new CodingWorkspaceError('Check request contains a newline', 'workspace_invalid_patch');
  const startedAt = Date.now();
  const request = [check.command, String(check.args.length), ...check.args].join('\n') + '\n';
  const result = await runWrapper(
    'check',
    runName,
    { ...options, timeoutMs: options.timeoutMs ?? (check.timeoutMs ? check.timeoutMs + 1_000 : undefined) },
    request,
    [kind],
  );
  if (result.exitCode === 64) throw new CodingWorkspaceError('Isolated check request was rejected', 'workspace_process_failed', result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  let results: verification.TestResult[];
  let report: verification.ReportInfo;
  if (check.report.format === 'junit') {
    const reportResult = await runWrapper('report', runName, options, undefined, [check.report.path]);
    try {
      results = testReport.parseJunit(reportResult.stdout);
      report = { format: 'junit', trusted: true, problem: null };
    } catch {
      results = [];
      report = { format: 'junit', trusted: false, problem: 'invalid' };
    }
  } else {
    results = verification.parseResults(output).map((item) => ({ ...item, fullName: item.fullName ?? item.name }));
    report = { format: 'stdout', trusted: true, problem: null };
  }
  const exitCode = result.exitCode;
  return {
    kind,
    command: `${check.command} ${check.args.join(' ')}`.trim(),
    exitCode,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    output,
    results,
    summary: verification.summarize(results, exitCode),
    report,
    check: { stage: check.stage, blocking: check.blocking },
  };
};

const applyGitPatch = async (root: string, patch: string, check: boolean, spawnFn: WorkspaceSpawnFn, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw new CodingWorkspaceError('Patch application was cancelled', 'workspace_aborted');
  const args = ['-C', root, 'apply', ...(check ? ['--check'] : []), '--binary'];
  const child = spawnFn(GIT_PATH, args, { env: safeChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stderr) < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - Buffer.byteLength(stderr));
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const fail = (error: CodingWorkspaceError) => {
    if (settled) return;
    settled = true;
    try {
      child.stdin.end();
    } catch {
      /* stream may already be closed */
    }
    child.kill?.('SIGTERM');
    signal?.removeEventListener('abort', abort);
    reject(error);
  };
  const abort = () => fail(new CodingWorkspaceError('Patch application was cancelled', 'workspace_aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', (error) => fail(new CodingWorkspaceError('git apply failed to start', 'workspace_spawn_failed', error.message)));
  child.once('close', (code) => {
    if (settled) return;
    if (code !== 0) fail(new CodingWorkspaceError(`git apply ${check ? 'check' : 'apply'} failed`, 'workspace_process_failed', stderr));
    else {
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve();
    }
  });
  try {
    child.stdin.end(patch);
  } catch (caught) {
    fail(new CodingWorkspaceError('Could not send patch to git', 'workspace_process_failed', String(caught)));
  }
  await promise;
};

const assertPatchTargetsSafe = async (root: string, files: readonly CodingPatchFile[]): Promise<void> => {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new CodingWorkspaceError('Patch root is not a real directory', 'workspace_out_of_scope');
  const realRoot = await fs.realpath(root);
  for (const file of files) {
    const parts = normalizePath(file.path).split('/');
    let current = realRoot;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => null);
      if (stat?.isSymbolicLink()) throw new CodingWorkspaceError(`Patch target escapes through symlink: ${file.path}`, 'workspace_out_of_scope');
      if (!stat) break;
    }
  }
};

export const applyPatch = async (
  root: string,
  patch: string,
  previewDigest: string,
  blocked: readonly BlockedPatch[] | boolean,
  options: WorkspaceOptions = {},
): Promise<string[]> => {
  const digest = createHash('sha256').update(patch).digest('hex');
  if (digest !== previewDigest) throw new CodingWorkspaceError('Patch digest does not match the preview', 'workspace_digest_mismatch');
  if (options.signal?.aborted) throw new CodingWorkspaceError('Patch application was cancelled', 'workspace_aborted');
  const parsed = parsePatchFiles(patch, undefined);
  const blockedPaths = typeof blocked === 'boolean' ? (blocked ? [{ path: '*', reason: 'caller blocked patch application' }] : []) : blocked;
  const intrinsicBlocked = parsed.blocked.filter((entry) => entry.reason !== 'high-risk project control or test path');
  if (blockedPaths.length || intrinsicBlocked.length) throw new CodingWorkspaceError('Patch contains blocked or unsafe paths', 'workspace_blocked_patch');
  await assertPatchTargetsSafe(root, parsed.files);
  const spawnFn = options.spawnFn ?? defaultSpawn;
  await applyGitPatch(root, patch, true, spawnFn, options.signal);
  await applyGitPatch(root, patch, false, spawnFn, options.signal);
  return parsed.files.map((file) => file.path);
};

// The part of a patch that touches `selected` paths, cut at `diff --git`
// headers. Throws when a selected path is not in the patch.
export const selectPatch = (patch: string, selected: readonly string[]): string => {
  const wanted = new Set(selected);
  const segments: { path: string; text: string }[] = [];
  for (const segment of patch.split(/(?=^diff --git )/m)) {
    if (!segment.startsWith('diff --git ')) continue;
    segments.push({ path: parsePatchFiles(segment, undefined).files[0].path, text: segment });
  }
  const found = new Set(segments.map((segment) => segment.path));
  const missing = selected.find((filePath) => !found.has(filePath));
  if (missing) throw new CodingWorkspaceError(`Selected file is not in the patch: ${missing}`, 'workspace_invalid_patch');
  return segments
    .filter((segment) => wanted.has(segment.path))
    .map((segment) => segment.text)
    .join('');
};

// A commit of `baseline` plus the working-tree contents of `paths` (deleted
// files removed), so the next round starts from what the developer has now.
// It goes through a private index: the real index, refs, stash and working
// tree are untouched, and the unreferenced commit is left for git gc.
// Secret-looking paths keep their baseline content.
export const snapshotBaseline = async (root: string, baseline: string, paths: readonly string[]): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-snapshot-'));
  const env = {
    ...safeChildEnv(),
    GIT_INDEX_FILE: path.join(directory, 'index'),
    GIT_AUTHOR_NAME: 'TaskPilot',
    GIT_AUTHOR_EMAIL: 'taskpilot@localhost',
    GIT_COMMITTER_NAME: 'TaskPilot',
    GIT_COMMITTER_EMAIL: 'taskpilot@localhost',
  };
  const git = async (args: string[]) => (await execFileAsync(GIT_PATH, ['-C', root, ...args], { env, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    await git(['read-tree', baseline]);
    const included = paths.filter((filePath) => !pathReason(filePath) && !looksSecret(filePath));
    if (included.length) await git(['update-index', '--add', '--remove', '--', ...included]);
    const tree = await git(['write-tree']);
    return await git(['commit-tree', tree, '-p', baseline, '-m', 'TaskPilot coding round baseline']);
  } catch (error) {
    throw new CodingWorkspaceError('Could not snapshot the working tree', 'workspace_process_failed', String((error as { stderr?: unknown }).stderr ?? ''));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

export const clean = async (runName: string, options: WorkspaceOptions = {}): Promise<void> => {
  await runWrapper('clean', runName, options);
};

export const parsePatchPreview = (patch: string, fileScope?: FileScope): CodingPatchPreview => {
  const parsed = parsePatchFiles(patch, fileScope);
  return { digest: createHash('sha256').update(patch).digest('hex'), files: parsed.files, patch, blocked: parsed.blocked };
};

export const isSafeRunName = (runName: string, runRoot = DEFAULT_RUN_ROOT): boolean => {
  const resolved = resolveRunName(runName, runRoot);
  return safeName.test(path.basename(resolved)) && path.dirname(resolved) === runRoot;
};

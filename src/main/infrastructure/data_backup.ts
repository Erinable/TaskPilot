import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { codedError } from './coded_error.ts';
import { writeFileAtomic } from './atomic_json_file.ts';
import { assertStorageVersion } from './persisted_json.ts';
import type { BackupResult, RestoredDrafts, RestorePrepared } from '../../shared/data_backup.ts';

// Only application data is portable. Chromium caches, CLI credentials, running
// agents and logs are deliberately outside this list. Renderer drafts are
// supplied by the renderer instead of copying a live Chromium database.
export const BACKUP_ROOTS = [
  'preferences.json',
  'repositories.json',
  'mastery.json',
  'notes_location.json',
  'notes_identities.json',
  'course_trust.json',
  'model_prices.json',
  'repos',
  'courses',
  'notes',
  'lab_drafts',
  'workspace.json',
  'requirements.json',
  'work-packages.json',
  'releases.json',
  'tutor.json',
  'events',
  'renderer_drafts.json',
] as const;
const MANIFEST = 'manifest.json';
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
export const RECOVERED_DRAFTS = 'recovered_drafts.json';

type BackupFile = { path: string; size: number; sha256: string };
export type BackupManifest = {
  version: 1;
  createdAt: string;
  appVersion: string | null;
  roots: string[];
  files: BackupFile[];
  externalNotes: string | null;
};
const invalid = (message: string): never => {
  throw codedError(`备份校验失败：${message}`, 'invalid_argument');
};
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  );
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const rootOf = (file: string) => file.split('/')[0]!;
const safeFile = (file: unknown): file is string =>
  typeof file === 'string' &&
  file.length > 0 &&
  !file.includes('\\') &&
  ![...file].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
  file.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  (BACKUP_ROOTS as readonly string[]).includes(rootOf(file));

export const validateDraftEntries = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('草稿格式不正确。');
  const entries = Object.entries(raw);
  if (entries.length > 1000 || entries.some(([key, value]) => !key.startsWith('taskpilot:draft:') || typeof value !== 'string' || value.length > 256 * 1024))
    return invalid('草稿格式或大小不正确。');
  if (JSON.stringify(raw).length > 5 * 1024 * 1024) return invalid('草稿总量过大。');
  return Object.fromEntries(entries) as Record<string, string>;
};

const validateManifestFiles = (files: unknown, roots: string[]): BackupFile[] => {
  if (!Array.isArray(files) || files.length > MAX_FILES) return invalid('文件清单不正确或文件过多。');
  const seen = new Set<string>();
  let total = 0;
  for (const file of files as BackupFile[]) {
    if (
      !file ||
      !safeFile(file.path) ||
      !roots.includes(rootOf(file.path)) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      return invalid('文件路径、大小或校验值不正确。');
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) return invalid('备份总量过大。');
  return files as BackupFile[];
};

const readManifest = async (directory: string): Promise<BackupManifest> => {
  const text = await fs.readFile(path.join(directory, MANIFEST), 'utf8');
  if (text.length > 30_000_000) return invalid('清单过大。');
  let raw: Partial<BackupManifest>;
  try {
    raw = JSON.parse(text) as Partial<BackupManifest>;
  } catch {
    return invalid('清单不是有效的 JSON。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return invalid('不支持的备份版本，请使用创建备份的版本或更新的 TaskPilot。');
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || (raw.appVersion !== null && typeof raw.appVersion !== 'string'))
    return invalid('缺少创建信息。');
  if (raw.externalNotes !== null && typeof raw.externalNotes !== 'string') return invalid('外部笔记目录格式不正确。');
  if (
    !Array.isArray(raw.roots) ||
    new Set(raw.roots).size !== raw.roots.length ||
    raw.roots.some((root) => !(BACKUP_ROOTS as readonly string[]).includes(root))
  )
    return invalid('包含不允许恢复的数据目录。');
  const files = validateManifestFiles(raw.files, raw.roots);
  return { version: 1, createdAt: raw.createdAt, appVersion: raw.appVersion, roots: raw.roots, files, externalNotes: raw.externalNotes };
};

const walk = async (base: string, relative: string): Promise<string[]> => {
  const file = path.join(base, relative);
  const info = await fs.lstat(file);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return invalid(`不支持符号链接或特殊文件：${relative}`);
  if (info.isFile()) return [relative];
  const result: string[] = [];
  for (const name of (await fs.readdir(file)).sort()) {
    result.push(...(await walk(base, `${relative}/${name}`)));
    if (result.length > MAX_FILES) return invalid('文件过多。');
  }
  return result;
};

const readCheckedFile = async (base: string, relative: string): Promise<Buffer> => {
  const target = path.join(base, relative);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || !inside(await fs.realpath(base), await fs.realpath(target)))
    return invalid(`文件不可读取或超出上限：${relative}`);
  const data = await fs.readFile(target);
  if (data.length > MAX_FILE_BYTES) return invalid(`文件过大：${relative}`);
  return data;
};

const storageVersion = (file: string): number | null => {
  if (/^lab_drafts\/[^/]+\/(lab|verify)\.json$/.test(file)) return 2;
  if (/^repos\/[^/]+\/labs\/[^/]+\/(hints|verify|rubric)\.json$/.test(file)) return 1;
  if (/^(?:repos\/[^/]+\/)?events\/cost_rollup\.json$/.test(file)) return 1;
  if (file.includes('/') && !/^repos\/[^/]+\/[^/]+\.json$/.test(file)) return null;
  const name = path.posix.basename(file);
  if (name === 'workspace.json') return 3;
  if (name === 'mastery.json' || name === 'course_trust.json') return 2;
  if (
    [
      'preferences.json',
      'repositories.json',
      'notes_location.json',
      'notes_identities.json',
      'model_prices.json',
      'requirements.json',
      'work-packages.json',
      'releases.json',
      'tutor.json',
      'cost_rollup.json',
    ].includes(name)
  )
    return 1;
  return null;
};
const eventFile = (file: string) => /^(?:repos\/[^/]+\/)?events\/[^/]+\.jsonl$/.test(file);
const assertDataVersion = (file: string, data: Buffer) => {
  const version = storageVersion(file);
  if (version !== null) assertStorageVersion(JSON.parse(data.toString('utf8')) as unknown, version, file);
  if (eventFile(file)) {
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: { storageVersion?: unknown };
      try {
        record = JSON.parse(line) as { storageVersion?: unknown };
      } catch {
        continue;
      }
      assertStorageVersion({ version: record?.storageVersion }, 1, file);
    }
  }
};
const checkFile = (file: BackupFile, data: Buffer) => {
  if (data.length !== file.size || digest(data) !== file.sha256) return invalid(`文件已变更或损坏：${file.path}`);
  assertDataVersion(file.path, data);
  if (file.path === 'renderer_drafts.json') validateDraftEntries(JSON.parse(data.toString('utf8')) as unknown);
};

const assertRootShape = async (base: string, root: string) => {
  const info = await fs.lstat(path.join(base, root));
  const correctType = root.endsWith('.json') ? info.isFile() : info.isDirectory();
  if (info.isSymbolicLink() || !correctType) return invalid(`数据文件或目录类型不正确：${root}`);
};

export const verifyBackup = async (directory: string): Promise<BackupManifest> => {
  const root = await fs.realpath(directory);
  const manifest = await readManifest(root);
  const payload = path.join(root, 'data');
  const payloadInfo = await fs.lstat(payload);
  if (!payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) return invalid('数据目录不能是符号链接。');
  const actual: string[] = [];
  for (const entry of manifest.roots) {
    await assertRootShape(payload, entry);
    actual.push(...(await walk(payload, entry)));
  }
  const expected = new Set(manifest.files.map((file) => file.path));
  if (actual.length !== manifest.files.length || actual.some((file) => !expected.has(file))) return invalid('文件清单与内容不一致。');
  const children = await fs.readdir(payload);
  if (children.some((entry) => !manifest.roots.includes(entry))) return invalid('包含清单之外的数据。');
  for (const file of manifest.files) checkFile(file, await readCheckedFile(payload, file.path));
  return manifest;
};

export const backupResult = (directory: string, manifest: BackupManifest, drafts = 0): BackupResult => ({
  path: directory,
  createdAt: manifest.createdAt,
  appVersion: manifest.appVersion,
  files: manifest.files.length,
  drafts,
  bytes: manifest.files.reduce((total, file) => total + file.size, 0),
  externalNotes: manifest.externalNotes,
});

export const createBackup = async (
  configDir: string,
  parent: string,
  options: { appVersion: string | null; externalNotes: string | null; drafts?: Record<string, string> },
): Promise<BackupResult> => {
  const source = await fs.realpath(configDir);
  const destinationParent = await fs.realpath(parent);
  if (inside(source, destinationParent)) return invalid('请选择应用数据目录之外的位置。');
  const createdAt = new Date().toISOString();
  const destination = path.join(destinationParent, `TaskPilot-backup-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(path.join(destination, 'data'), { recursive: true, mode: 0o700 });
  const manifest: BackupManifest = { version: 1, createdAt, appVersion: options.appVersion, roots: [], files: [], externalNotes: options.externalNotes };
  let total = 0;
  for (const root of BACKUP_ROOTS) {
    if (root === 'renderer_drafts.json' || !(await exists(path.join(source, root)))) continue;
    manifest.roots.push(root);
    const files = await walk(source, root);
    if ((await fs.lstat(path.join(source, root))).isDirectory()) await fs.mkdir(path.join(destination, 'data', root), { recursive: true, mode: 0o700 });
    for (const relative of files) {
      const data = await readCheckedFile(source, relative);
      total += data.length;
      if (total > MAX_TOTAL_BYTES || manifest.files.length >= MAX_FILES) return invalid('备份过大。');
      const target = path.join(destination, 'data', relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, data, { mode: 0o600, flag: 'wx' });
      manifest.files.push({ path: relative, size: data.length, sha256: digest(data) });
    }
  }
  const drafts = Buffer.from(JSON.stringify(validateDraftEntries(options.drafts ?? {})));
  await fs.writeFile(path.join(destination, 'data', 'renderer_drafts.json'), drafts, { mode: 0o600, flag: 'wx' });
  manifest.roots.push('renderer_drafts.json');
  manifest.files.push({ path: 'renderer_drafts.json', size: drafts.length, sha256: digest(drafts) });
  // The manifest is the completion marker; an interrupted copy is never offered
  // as a valid backup. Every file is checked again before staging a restore.
  await fs.writeFile(path.join(destination, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  return backupResult(destination, manifest, Object.keys(options.drafts ?? {}).length);
};

const assertPlainDirectory = async (directory: string) => {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return invalid(`目录不能是符号链接或特殊文件：${directory}`);
};
const pendingDir = (configDir: string) => `${path.resolve(configDir)}.restore-pending`;
const historyDir = (configDir: string, id: string) => path.join(`${path.resolve(configDir)}.restore-history`, id);

const protectCurrentVersions = async (configDir: string) => {
  for (const root of BACKUP_ROOTS) {
    if (!(await exists(path.join(configDir, root)))) continue;
    for (const file of await walk(configDir, root)) {
      if (storageVersion(file) === null && !eventFile(file)) continue;
      try {
        assertDataVersion(file, await readCheckedFile(configDir, file));
      } catch (error) {
        // Recovery can replace damaged JSON, with its original kept in history.
        // A format from a newer app must first be opened by that newer version.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
};

const verifyRestorePayload = async (configDir: string, pending: string, manifest: BackupManifest) => {
  for (const root of manifest.roots) {
    const base = (await exists(path.join(pending, 'data', root))) ? path.join(pending, 'data') : configDir;
    const files = manifest.files.filter((entry) => rootOf(entry.path) === root);
    const expected = new Set(files.map((file) => file.path));
    await assertRootShape(base, root);
    const actual = await walk(base, root);
    if (actual.length !== files.length || actual.some((file) => !expected.has(file))) return invalid(`恢复文件清单不一致：${root}`);
    for (const file of files) checkFile(file, await readCheckedFile(base, file.path));
  }
};

const writeHistoryManifest = async (rollback: string, appVersion: string | null, configDir: string) => {
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), appVersion, roots: [], files: [], externalNotes: null };
  try {
    const location = JSON.parse(await fs.readFile(path.join(rollback, 'data', 'notes_location.json'), 'utf8')) as { directory?: unknown };
    if (
      typeof location?.directory === 'string' &&
      path.isAbsolute(location.directory) &&
      path.resolve(location.directory) !== path.join(path.resolve(configDir), 'notes')
    )
      manifest.externalNotes = location.directory;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const root of BACKUP_ROOTS) {
    if (!(await exists(path.join(rollback, 'data', root)))) continue;
    manifest.roots.push(root);
    for (const file of await walk(path.join(rollback, 'data'), root)) {
      const data = await readCheckedFile(path.join(rollback, 'data'), file);
      manifest.files.push({ path: file, size: data.length, sha256: digest(data) });
    }
  }
  await writeFileAtomic(path.join(rollback, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
};

export const backupIdentity = (manifest: BackupManifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

export const prepareRestore = async (configDir: string, directory: string, expectedIdentity?: string): Promise<RestorePrepared> => {
  const manifest = await verifyBackup(directory);
  if (expectedIdentity !== undefined && backupIdentity(manifest) !== expectedIdentity)
    throw codedError('备份在预览后已变更，请重新选择并确认。', 'invalid_state');
  await protectCurrentVersions(configDir);
  const pending = pendingDir(configDir);
  if (await exists(pending)) throw codedError('已有待恢复的备份，请先重新启动应用。', 'invalid_state');
  const id = randomUUID();
  const staging = `${pending}-${id}`;
  await fs.mkdir(staging, { mode: 0o700 });
  await fs.mkdir(path.join(staging, 'data'), { mode: 0o700 });
  for (const root of manifest.roots)
    if ((await fs.lstat(path.join(directory, 'data', root))).isDirectory()) await fs.mkdir(path.join(staging, 'data', root), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const data = await readCheckedFile(path.join(directory, 'data'), file.path);
    checkFile(file, data);
    const target = path.join(staging, 'data', file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { mode: 0o600, flag: 'wx' });
  }
  await fs.writeFile(path.join(staging, MANIFEST), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(staging, 'restore.json'), JSON.stringify({ version: 1, id, completed: [] }), { mode: 0o600, flag: 'wx' });
  await verifyBackup(staging);
  await fs.rename(staging, pending);
  return { restartRequired: true, rollbackPath: historyDir(configDir, id) };
};

// Called before any store or window opens. Directory renames are atomic; the
// journal lets the next launch continue if the app stopped between two roots.
export const applyPendingRestore = async (configDir: string, appVersion: string | null = null): Promise<boolean> => {
  const pending = pendingDir(configDir);
  if (!(await exists(pending))) return false;
  await assertPlainDirectory(pending);
  await assertPlainDirectory(path.join(pending, 'data'));
  const manifest = await readManifest(pending);
  const journal = JSON.parse(await fs.readFile(path.join(pending, 'restore.json'), 'utf8')) as { version: number; id: string; completed: string[] };
  if (
    journal.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    !Array.isArray(journal.completed) ||
    journal.completed.some((root) => !(BACKUP_ROOTS as readonly string[]).includes(root))
  )
    return invalid('恢复记录损坏，请保留恢复目录并联系维护者。');
  await protectCurrentVersions(configDir);
  await verifyRestorePayload(configDir, pending, manifest);
  const rollback = historyDir(configDir, journal.id);
  for (const directory of [path.dirname(rollback), rollback, path.join(rollback, 'data')]) {
    if (await exists(directory)) await assertPlainDirectory(directory);
    else await fs.mkdir(directory, { mode: 0o700 });
  }
  for (const root of BACKUP_ROOTS) {
    if (journal.completed.includes(root)) continue;
    const staged = path.join(pending, 'data', root);
    const target = path.join(configDir, root);
    const original = path.join(rollback, 'data', root);
    const stagedExists = await exists(staged);
    if (manifest.roots.includes(root)) {
      const base = stagedExists ? path.join(pending, 'data') : configDir;
      for (const file of manifest.files.filter((entry) => rootOf(entry.path) === root)) checkFile(file, await readCheckedFile(base, file.path));
      if (stagedExists) {
        if (await exists(target)) {
          if (await exists(original)) return invalid(`恢复目录状态冲突：${root}`);
          await fs.rename(target, original);
        }
        await fs.rename(staged, target);
      }
    } else if (await exists(target)) {
      if (await exists(original)) return invalid(`恢复目录状态冲突：${root}`);
      await fs.rename(target, original);
    }
    journal.completed.push(root);
    await writeFileAtomic(path.join(pending, 'restore.json'), JSON.stringify(journal), { mode: 0o600 });
  }
  const draftsFile = path.join(configDir, 'renderer_drafts.json');
  if (await exists(draftsFile)) {
    const entries = validateDraftEntries(JSON.parse(await fs.readFile(draftsFile, 'utf8')) as unknown);
    const recovered: RestoredDrafts = { token: journal.id, entries };
    await writeFileAtomic(path.join(configDir, RECOVERED_DRAFTS), JSON.stringify(recovered), { mode: 0o600 });
  }
  await writeHistoryManifest(rollback, appVersion, configDir);
  await fs.writeFile(
    path.join(rollback, 'RESTORE.txt'),
    `TaskPilot 恢复前的数据。恢复时间：${new Date().toISOString()}\n保留此目录；外部仓库源代码和外部笔记未被改动。\n`,
    { mode: 0o600 },
  );
  // Retain the completed journal beside the originals; no user data is deleted.
  await fs.rename(pending, path.join(rollback, 'completed-restore'));
  return true;
};

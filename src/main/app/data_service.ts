import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { codedError } from '../infrastructure/coded_error.ts';
import * as backups from '../infrastructure/data_backup.ts';
import { flushLogs } from '../infrastructure/logger.ts';
import { writeFileAtomic } from '../infrastructure/atomic_json_file.ts';
import type { AppContext } from './app_context.ts';
import type { BackupPreview, RestoredDrafts } from '../../shared/data_backup.ts';

type DataContext = Pick<AppContext, 'configDir' | 'appVersion' | 'notes' | 'shell' | 'backgroundRuns' | 'flushStores' | 'getPreferences' | 'repositories'>;

export const createDataService = (ctx: DataContext) => {
  let selected: { id: string; directory: string; identity: string } | null = null;
  const pick = async () => {
    if (!ctx.shell.pickDirectory) throw codedError('当前环境无法选择文件夹。', 'unsupported');
    return ctx.shell.pickDirectory(null);
  };
  const ready = async () => {
    if (ctx.backgroundRuns.busy().length) throw codedError('请先等待或取消正在运行的任务，再备份或恢复。', 'invalid_state');
    await ctx.flushStores();
  };
  const externalNotes = () => {
    const directory = ctx.notes?.directory ?? null;
    return directory && path.resolve(directory) !== path.join(path.resolve(ctx.configDir), 'notes') ? directory : null;
  };
  const backup = async (drafts: unknown) => {
    const entries = backups.validateDraftEntries(drafts ?? {});
    const directory = await pick();
    if (!directory) return null;
    await ready();
    return backups.createBackup(ctx.configDir, directory, { appVersion: ctx.appVersion ?? null, externalNotes: externalNotes(), drafts: entries });
  };
  const previewRestore = async (): Promise<BackupPreview | null> => {
    selected = null;
    const directory = await pick();
    if (!directory) return null;
    const manifest = await backups.verifyBackup(directory);
    const id = randomUUID();
    selected = { id, directory, identity: backups.backupIdentity(manifest) };
    const draftFile = manifest.files.find((file) => file.path === 'renderer_drafts.json');
    const drafts = draftFile
      ? Object.keys(backups.validateDraftEntries(JSON.parse(await fs.readFile(path.join(directory, 'data', draftFile.path), 'utf8')) as unknown)).length
      : 0;
    return { id, ...backups.backupResult(directory, manifest), drafts };
  };
  const restore = async (id: unknown, drafts: unknown = {}) => {
    if (!selected || id !== selected.id) throw codedError('备份选择已过期，请重新选择并预览。', 'invalid_argument');
    const entries = backups.validateDraftEntries(drafts);
    await ready();
    // Capture the current Chromium drafts as portable data before the restart,
    // so replacing an identically named restored draft never loses its original.
    await writeFileAtomic(path.join(ctx.configDir, 'renderer_drafts.json'), JSON.stringify(entries), { mode: 0o600 });
    const result = await backups.prepareRestore(ctx.configDir, selected.directory, selected.identity);
    selected = null;
    return result;
  };
  const restoredDrafts = async (): Promise<RestoredDrafts | null> => {
    const file = path.join(ctx.configDir, backups.RECOVERED_DRAFTS);
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as RestoredDrafts;
      if (typeof raw.token !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.token)) throw codedError('恢复草稿记录损坏，原文件已保留。', 'invalid_state');
      return { token: raw.token, entries: backups.validateDraftEntries(raw.entries) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const acknowledgeDrafts = async (token: unknown): Promise<true> => {
    const restored = await restoredDrafts();
    if (!restored || token !== restored.token) throw codedError('恢复草稿记录已变更，请重试。', 'invalid_argument');
    // The fixed application-owned path is the only file this operation removes.
    await fs.unlink(path.join(ctx.configDir, backups.RECOVERED_DRAFTS));
    return true;
  };
  const diagnostics = () => {
    const prefs = ctx.getPreferences();
    return [
      'TaskPilot 本地诊断信息（不含日志正文、项目源码或认证信息）',
      `时间：${new Date().toISOString()}`,
      `TaskPilot：${ctx.appVersion ?? 'unknown'}`,
      `平台：${process.platform} ${process.arch}`,
      `Electron：${process.versions.electron ?? 'not running in Electron'}`,
      `Node：${process.versions.node}`,
      `PATH 来源：${prefs.environment.pathSource}`,
      `隔离方式：${prefs.coding.isolation}`,
      `仓库数量：${ctx.repositories.list().length}`,
      `运行中任务：${ctx.backgroundRuns.busy().length}`,
      ...Object.entries(prefs.agents).map(([role, config]) => `${role}：${config.cli}`),
      '请另附操作步骤和界面显示的错误代码；分享日志前检查其中的私人路径与内容。',
    ].join('\n');
  };
  const revealLogs = async (): Promise<true> => {
    if (!ctx.shell.revealPath) throw codedError('当前环境无法打开日志目录。', 'unsupported');
    const directory = path.join(ctx.configDir, 'logs');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await flushLogs();
    await ctx.shell.revealPath(directory);
    return true;
  };
  const restart = async (): Promise<true> => {
    if (!ctx.shell.restart) throw codedError('请退出并重新打开 TaskPilot，以应用备份恢复。', 'unsupported');
    await ready();
    ctx.shell.restart();
    return true;
  };
  return { backup, previewRestore, restore, restoredDrafts, acknowledgeDrafts, diagnostics, revealLogs, restart };
};

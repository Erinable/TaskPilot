import * as backups from '../infrastructure/data_backup.ts';

type RecoveryDeps = {
  pickDirectory: () => Promise<string | null>;
  confirm: (summary: string) => Promise<boolean>;
  restart: () => void;
};

// Available even when a damaged store prevents the normal settings from loading.
export const restoreAtStartup = async (configDir: string, deps: RecoveryDeps): Promise<boolean> => {
  const directory = await deps.pickDirectory();
  if (!directory) return false;
  const manifest = await backups.verifyBackup(directory);
  const summary = [
    `创建时间：${manifest.createdAt}`,
    `创建版本：${manifest.appVersion ?? '未知'}`,
    `文件数量：${manifest.files.length}`,
    '恢复将在重启时替换 TaskPilot 数据；当前数据会保留在恢复历史目录。项目源代码不会被修改。',
    ...(manifest.externalNotes ? [`此备份的外部笔记目录未打包，请另行恢复：${manifest.externalNotes}`] : []),
  ].join('\n');
  if (!(await deps.confirm(summary))) return false;
  await backups.prepareRestore(configDir, directory, backups.backupIdentity(manifest));
  deps.restart();
  return true;
};

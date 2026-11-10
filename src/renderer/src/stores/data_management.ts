import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call, IpcError } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction } from '@/lib/feedback.ts';
import { collectLocalDrafts } from '@/lib/local_draft.ts';
import type { BackupPreview, BackupResult } from '@shared/data_backup.ts';

export const useDataManagementStore = defineStore('data-management', () => {
  const busy = ref(false);
  const error = ref<string | null>(null);
  const status = ref<string | null>(null);
  const lastBackup = ref<BackupResult | null>(null);
  const preview = ref<BackupPreview | null>(null);
  const rollbackPath = ref<string | null>(null);
  const diagnostics = ref<string | null>(null);
  const run = async (operation: () => Promise<void>) => {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    status.value = null;
    try {
      await operation();
    } catch (failure) {
      error.value = failure instanceof IpcError ? `${failure.message}（${failure.code}）` : describeError(failure);
    } finally {
      busy.value = false;
    }
  };
  const backup = () =>
    run(async () => {
      const saved = await call(window.taskpilot.data.backup(collectLocalDrafts()));
      if (!saved) return;
      lastBackup.value = saved;
      status.value = `备份完成：${saved.files} 个文件，${saved.drafts} 份未提交草稿。请妥善保存备份文件夹。`;
    });
  const chooseRestore = () =>
    run(async () => {
      preview.value = null;
      preview.value = await call(window.taskpilot.data.previewRestore());
    });
  const prepareRestore = () =>
    run(async () => {
      const selected = preview.value;
      if (!selected || rollbackPath.value) return;
      const accepted = await confirmAction({
        title: '准备恢复这份备份？',
        body: `将恢复 ${selected.createdAt} 创建的备份（${selected.files} 个文件）。重新启动时会替换 TaskPilot 数据，并保留当前数据作为恢复历史。项目源代码和外部笔记不会被修改。请先保存其他编辑中的内容。`,
        accept: '准备恢复',
        danger: true,
      });
      if (!accepted) return;
      const prepared = await call(window.taskpilot.data.restore(selected.id, collectLocalDrafts()));
      rollbackPath.value = prepared.rollbackPath;
      status.value = '备份已校验并暂存。重新启动后恢复；当前数据会保留在下方恢复历史目录。';
      preview.value = null;
    });
  const restart = () =>
    run(async () => {
      await call(window.taskpilot.data.restart());
    });
  const revealLogs = () =>
    run(async () => {
      await call(window.taskpilot.data.revealLogs());
    });
  const copyDiagnostics = () =>
    run(async () => {
      diagnostics.value = await call(window.taskpilot.data.diagnostics());
      try {
        await navigator.clipboard.writeText(diagnostics.value);
        status.value = '诊断信息已复制。可连同操作步骤与错误代码一起反馈。';
      } catch {
        status.value = '诊断信息已生成，请从下方文本框手动复制。';
      }
    });
  return { busy, error, status, lastBackup, preview, rollbackPath, diagnostics, backup, chooseRestore, prepareRestore, restart, revealLogs, copyDiagnostics };
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import DataPage from '@/components/settings/DataPage.vue';
import { useDataManagementStore } from '@/stores/data_management.ts';
import { confirmAction } from '@/lib/feedback.ts';
import { draftKey } from '@/lib/local_draft.ts';
import type { BackupPreview, BackupResult, RestorePrepared } from '@shared/data_backup.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import { installFakeApi, fail, ok } from '../ipc_fakes.ts';
import { mountView } from '../mount_view.ts';

vi.mock('@/lib/feedback.ts', () => ({
  confirmAction: vi.fn(async () => true),
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

const saved: BackupResult = {
  path: '/backups/taskpilot-20261110',
  createdAt: '2026-11-10T01:00:00.000Z',
  appVersion: '0.1.0',
  files: 12,
  bytes: 2048,
  externalNotes: '/notes/Obsidian',
  drafts: 1,
};
const selected: BackupPreview = { id: 'verified-backup', ...saved };
const prepared: RestorePrepared = { restartRequired: true, rollbackPath: '/config/restore-history/before-20261110' };
const diagnosticText = 'TaskPilot 0.1.0\nPlatform: darwin\nProduct Lead: pi\nArchitect: opencode';
let api: ReturnType<typeof installFakeApi>;

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  api = installFakeApi({
    data: {
      backup: () => ok(saved),
      previewRestore: () => ok(selected),
      restore: () => ok(prepared),
      restart: () => ok(true),
      diagnostics: () => ok(diagnosticText),
      revealLogs: () => ok(true),
    },
  });
});

test('backup passes the exact local draft envelopes and excludes unrelated preferences', async () => {
  const key = draftKey(['compose', 'repo-a', 'project']);
  const raw = JSON.stringify({ version: 1, baseline: 'initial', data: { title: '邮件登录', text: '尚未提交的需求' } });
  localStorage.setItem(key, raw);
  localStorage.setItem('taskpilot.onboarding.path', 'course');
  const store = useDataManagementStore();
  await store.backup();
  expect(api.data.backup).toHaveBeenCalledExactlyOnceWith({ [key]: raw });
  expect(structuredClone(api.data.backup.mock.calls[0][0])).toEqual({ [key]: raw });
  expect(store.lastBackup).toEqual(saved);
  expect(store.status).toContain('备份完成');
  expect(store.status).toContain('1 份未提交草稿');
  expect(localStorage.getItem(key)).toBe(raw);
});

test('cancelling a later backup keeps backup history without displaying another success', async () => {
  const store = useDataManagementStore();
  await store.backup();
  api.data.backup.mockReturnValueOnce(ok(null));
  await store.backup();
  expect(store.lastBackup).toEqual(saved);
  expect(store.status).toBeNull();
  expect(store.error).toBeNull();
  expect(store.busy).toBe(false);
});

test('cancelling backup selection clears the old preview and never initiates restore', async () => {
  const store = useDataManagementStore();
  await store.chooseRestore();
  expect(store.preview).toEqual(selected);
  api.data.previewRestore.mockReturnValueOnce(ok(null));
  await store.chooseRestore();
  expect(store.preview).toBeNull();
  expect(store.status).toBeNull();
  expect(confirmAction).not.toHaveBeenCalled();
  expect(api.data.restore).not.toHaveBeenCalled();
});

test('an unreadable local draft stops backup instead of silently excluding the draft', async () => {
  localStorage.setItem(draftKey(['compose', 'repo-a', 'course']), '{');
  const store = useDataManagementStore();
  await store.backup();
  expect(store.error).toBeTruthy();
  expect(store.lastBackup).toBeNull();
  expect(store.status).toBeNull();
  expect(api.data.backup).not.toHaveBeenCalled();
});

test('restore needs a preview and explicit confirmation; rejecting confirmation keeps the preview', async () => {
  const store = useDataManagementStore();
  await store.prepareRestore();
  expect(confirmAction).not.toHaveBeenCalled();
  expect(api.data.restore).not.toHaveBeenCalled();
  await store.chooseRestore();
  expect(api.data.restore).not.toHaveBeenCalled();
  vi.mocked(confirmAction).mockResolvedValueOnce(false);
  await store.prepareRestore();
  expect(confirmAction).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      title: '准备恢复这份备份？',
      body: expect.stringContaining(selected.createdAt),
      accept: '准备恢复',
      danger: true,
    }),
  );
  expect(vi.mocked(confirmAction).mock.calls[0][0].body).toContain('项目源代码和外部笔记不会被修改');
  expect(store.preview).toEqual(selected);
  expect(store.rollbackPath).toBeNull();
  expect(store.status).toBeNull();
  expect(api.data.restore).not.toHaveBeenCalled();
  expect(api.data.restart).not.toHaveBeenCalled();
});

test('parallel restore clicks preserve the latest local drafts and stage once before an explicit restart', async () => {
  const key = draftKey(['compose', 'repo-a', 'course']);
  localStorage.setItem(key, JSON.stringify({ version: 1, baseline: 'initial', data: { text: '选择备份前的输入' } }));
  localStorage.setItem('taskpilot.onboarding.path', 'course');
  const confirmation = Promise.withResolvers<boolean>();
  const restoring = Promise.withResolvers<IpcResult<RestorePrepared>>();
  vi.mocked(confirmAction).mockReturnValueOnce(confirmation.promise);
  api.data.restore.mockReturnValueOnce(restoring.promise);
  const store = useDataManagementStore();
  await store.chooseRestore();
  const first = store.prepareRestore();
  await store.prepareRestore();
  expect(store.busy).toBe(true);
  expect(confirmAction).toHaveBeenCalledTimes(1);
  expect(api.data.restore).not.toHaveBeenCalled();
  const current = JSON.stringify({ version: 1, baseline: 'initial', data: { text: '确认恢复前继续编辑的输入' } });
  localStorage.setItem(key, current);
  confirmation.resolve(true);
  await flushPromises();
  await store.prepareRestore();
  expect(api.data.restore).toHaveBeenCalledExactlyOnceWith(selected.id, { [key]: current });
  expect(structuredClone(api.data.restore.mock.calls[0][1])).toEqual({ [key]: current });
  expect(localStorage.getItem(key)).toBe(current);
  expect(store.rollbackPath).toBeNull();
  restoring.resolve({ ok: true, data: prepared });
  await first;
  expect(store.preview).toBeNull();
  expect(store.rollbackPath).toBe(prepared.rollbackPath);
  expect(store.status).toContain('重新启动后恢复');
  expect(api.data.restart).not.toHaveBeenCalled();
  await store.restart();
  expect(api.data.restart).toHaveBeenCalledTimes(1);
});

test('restore refuses to proceed if the current local drafts cannot be preserved', async () => {
  const key = draftKey(['compose', 'repo-a', 'project']);
  localStorage.setItem(key, '{');
  const store = useDataManagementStore();
  await store.chooseRestore();
  await store.prepareRestore();
  expect(confirmAction).toHaveBeenCalledTimes(1);
  expect(store.error).toBeTruthy();
  expect(store.preview).toEqual(selected);
  expect(store.rollbackPath).toBeNull();
  expect(store.status).toBeNull();
  expect(api.data.restore).not.toHaveBeenCalled();
  expect(api.data.restart).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe('{');
});

test('parallel data operations cannot create duplicate backups or overlap a pending backup', async () => {
  const saving = Promise.withResolvers<IpcResult<BackupResult | null>>();
  api.data.backup.mockReturnValueOnce(saving.promise);
  const store = useDataManagementStore();
  const first = store.backup();
  await Promise.all([store.backup(), store.chooseRestore(), store.copyDiagnostics(), store.revealLogs()]);
  expect(api.data.backup).toHaveBeenCalledTimes(1);
  expect(api.data.previewRestore).not.toHaveBeenCalled();
  expect(api.data.diagnostics).not.toHaveBeenCalled();
  expect(api.data.revealLogs).not.toHaveBeenCalled();
  saving.resolve({ ok: true, data: saved });
  await first;
  expect(store.busy).toBe(false);
  expect(store.lastBackup).toEqual(saved);
});

test('DataPage keeps a failed restore retryable and does not offer restart', async () => {
  const store = useDataManagementStore();
  await store.chooseRestore();
  api.data.restore.mockReturnValueOnce(fail('invalid_argument', '备份内容已改变，请重新选择'));
  const wrapper = await mountView(DataPage);
  const restore = wrapper.findAll('button').find((button) => button.text() === '使用这份备份…')!;
  await restore.trigger('click');
  await flushPromises();
  expect(api.data.restore).toHaveBeenCalledWith(selected.id, {});
  expect(wrapper.get('[role="alert"]').text()).toContain('备份内容已改变');
  expect(wrapper.get('[role="alert"]').text()).toContain('invalid_argument');
  expect(wrapper.findAll('button').some((button) => button.text() === '重新启动并恢复')).toBe(false);
  expect(store.preview).toEqual(selected);
  expect(store.rollbackPath).toBeNull();
  expect(store.status).toBeNull();
  expect(api.data.restart).not.toHaveBeenCalled();
  await restore.trigger('click');
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.findAll('button').some((button) => button.text() === '重新启动并恢复')).toBe(true);
});

test('DataPage exposes manual diagnostic copying when the clipboard fails', async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard denied'));
  const wrapper = await mountView(DataPage);
  const copy = wrapper.findAll('button').find((button) => button.text() === '复制诊断信息')!;
  await copy.trigger('click');
  await flushPromises();
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(diagnosticText);
  const text = wrapper.get<HTMLTextAreaElement>('textarea[aria-label="可复制的诊断信息"]');
  expect(text.element.value).toBe(diagnosticText);
  expect(text.attributes('readonly')).toBeDefined();
  expect(wrapper.get('[role="status"]').text()).toContain('手动复制');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});

test('DataPage explains source and external-note backup limits and preserves their paths', async () => {
  const store = useDataManagementStore();
  await store.backup();
  await store.chooseRestore();
  const wrapper = await mountView(DataPage);
  expect(wrapper.text()).toContain('项目源代码与外部笔记目录需要另行备份');
  expect(wrapper.text()).toContain('外部笔记未打包，请另行备份');
  expect(wrapper.text()).toContain('请确认该目录仍可访问，或恢复后重新选择笔记目录');
  expect(wrapper.findAll('code').map((code) => code.text())).toContain(saved.externalNotes);
  await store.prepareRestore();
  await flushPromises();
  expect(wrapper.text()).toContain('恢复前的数据将保留在');
  expect(wrapper.findAll('code').map((code) => code.text())).toContain(prepared.rollbackPath);
  expect(wrapper.text()).toContain('项目源代码与外部笔记目录需要另行备份');
});

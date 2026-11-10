// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import * as drafts from '../../../src/renderer/src/lib/local_draft.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';

type Form = { text: string };
const validate = (value: unknown): value is Form => drafts.draftObject(value) && Object.keys(value).length === 1 && typeof value.text === 'string';
const opened: drafts.LocalDraft<Form>[] = [];
const open = (initial = { text: '' }, key = drafts.draftKey(['compose', 'repo-a'])) => {
  const draft = drafts.createLocalDraft({ key, initial, validate });
  opened.push(draft);
  return draft;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const draft of opened.splice(0)) draft.stop();
  vi.restoreAllMocks();
});

test('restart offers recovery before applying input and explicit discard restores the official baseline', () => {
  const first = open();
  first.value.value.text = '未提交的需求';
  first.stop();
  const restarted = open();
  expect(restarted.value.value.text).toBe('');
  expect(restarted.state.pending).toBe(true);
  restarted.restore();
  expect(restarted.value.value.text).toBe('未提交的需求');
  expect(restarted.state.restored).toBe(true);
  restarted.discard();
  expect(restarted.value.value.text).toBe('');
  expect(localStorage.getItem(drafts.draftKey(['compose', 'repo-a']))).toBeNull();
});

test('changed official content never receives an old draft and the old entry remains until discarded', () => {
  const first = open({ text: '正式回答' });
  first.value.value.text = '旧草稿';
  const raw = localStorage.getItem(drafts.draftKey(['compose', 'repo-a']));
  first.stop();
  const restarted = open({ text: '更新后的正式回答' });
  expect(restarted.state.conflict).toBe(true);
  restarted.restore();
  expect(restarted.value.value.text).toBe('更新后的正式回答');
  expect(localStorage.getItem(drafts.draftKey(['compose', 'repo-a']))).toBe(raw);
  restarted.discard();
  restarted.value.value.text = '新草稿';
  expect(JSON.parse(localStorage.getItem(drafts.draftKey(['compose', 'repo-a']))!).data.text).toBe('新草稿');
});

test('future formats stay untouched on edit, clear, discard and backup restoration', () => {
  const key = drafts.draftKey(['compose', 'repo-a']);
  const future = JSON.stringify({ version: 2, data: { text: '新版本草稿' } });
  localStorage.setItem(key, future);
  const draft = open();
  draft.value.value.text = '当前输入';
  expect(draft.clear()).toBe(false);
  draft.discard();
  expect(draft.state.error).toContain('更新版本');
  expect(localStorage.getItem(key)).toBe(future);
  expect(drafts.collectLocalDrafts()[key]).toBe(future);
  expect(() => drafts.restoreLocalDrafts({ [key]: JSON.stringify({ version: 1, data: { text: 'old' } }) })).toThrow('更新版本');
  expect(localStorage.getItem(key)).toBe(future);
});

test('a future format written after opening a form is protected from later edits and cleanup', () => {
  const key = drafts.draftKey(['compose', 'repo-a']);
  const draft = open();
  draft.value.value.text = '旧窗口';
  const future = JSON.stringify({ version: 3, data: { text: '更新版本' } });
  localStorage.setItem(key, future);
  draft.value.value.text = '继续输入';
  draft.discard();
  expect(localStorage.getItem(key)).toBe(future);
  expect(draft.state.error).toContain('更新版本');
});

test('malformed and oversized storage are retained without being loaded into the form', () => {
  const key = drafts.draftKey(['compose', 'repo-a']);
  localStorage.setItem(key, JSON.stringify({ version: 1, baseline: drafts.draftFingerprint({ text: '' }), data: { text: [], unknown: true } }));
  const malformed = open();
  expect(malformed.state.error).toContain('无法恢复');
  expect(malformed.value.value.text).toBe('');
  const original = localStorage.getItem(key);
  malformed.value.value.text = '输入';
  expect(localStorage.getItem(key)).toBe(original);
  const oversized = open({ text: '' }, drafts.draftKey(['compose', 'repo-b']));
  oversized.value.value.text = '文'.repeat(drafts.MAX_DRAFT_BYTES);
  expect(oversized.state.error).toContain('256 KB');
  expect(localStorage.getItem(drafts.draftKey(['compose', 'repo-b']))).toBeNull();
});

test('storage write errors remain visible while user input stays editable', () => {
  const draft = open();
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('quota exceeded');
  });
  draft.value.value.text = '保留输入';
  expect(draft.state.error).toContain('quota exceeded');
  expect(draft.value.value.text).toBe('保留输入');
  draft.value.value.text += '，继续编辑重试';
  expect(draft.state.error).toBeNull();
  expect(draft.state.saved).toBe(true);
});

test('accepting a saved snapshot rebases later edits for recovery against the new official content', () => {
  const draft = open();
  draft.value.value.text = '提交后的继续输入';
  draft.accept({ text: '已提交内容' });
  draft.stop();
  const restarted = open({ text: '已提交内容' });
  expect(restarted.state.pending).toBe(true);
  restarted.restore();
  expect(restarted.value.value.text).toBe('提交后的继续输入');
});

test('backup restore validates the full batch before writing and excludes unrelated browser preferences', () => {
  localStorage.setItem('taskpilot.sidebarCollapsed', 'true');
  const key = drafts.draftKey(['answers', 'repo-a', 'r1']);
  const raw = JSON.stringify({ version: 1, baseline: 'x', data: { text: '草稿' } });
  expect(() => drafts.restoreLocalDrafts({ [key]: raw, unrelated: raw })).toThrow();
  expect(localStorage.getItem(key)).toBeNull();
  drafts.restoreLocalDrafts({ [key]: raw });
  expect(drafts.collectLocalDrafts()).toEqual({ [key]: raw });
});

test('recovered backup entries are acknowledged only after successful local storage writes', async () => {
  const key = drafts.draftKey(['compose', 'repo-a']);
  const raw = JSON.stringify({ version: 1, baseline: 'x', data: { text: '恢复' } });
  const api = installFakeApi({ data: { restoredDrafts: () => ok({ token: 'recovered', entries: { [key]: raw } }), acknowledgeDrafts: () => ok(true) } });
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  await expect(drafts.recoverBackupDrafts()).rejects.toThrow('disk full');
  expect(api.data.acknowledgeDrafts).not.toHaveBeenCalled();
  await expect(drafts.recoverBackupDrafts()).resolves.toBe(true);
  expect(api.data.acknowledgeDrafts).toHaveBeenCalledWith('recovered');
});

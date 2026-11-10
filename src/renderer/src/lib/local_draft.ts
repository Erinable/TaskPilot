// Unsubmitted renderer drafts live in this Electron profile's localStorage.
// Every entry has its own identity and baseline; newer formats are never replaced.
import { reactive, ref, watch } from 'vue';
import type { Ref } from 'vue';

import { call } from './ipc.ts';

export const DRAFT_PREFIX = 'taskpilot:draft:';
export const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_BACKUP_DRAFT_BYTES = 5 * 1024 * 1024;

const backupEntry = (key: string, raw: string) => {
  if (!key.startsWith(DRAFT_PREFIX) || key.length > 2048 || new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES)
    throw new Error('草稿身份或内容超过备份上限');
  const envelope: unknown = JSON.parse(raw);
  if (!draftObject(envelope) || !Number.isInteger(envelope.version) || Number(envelope.version) < 1) throw new Error('草稿格式无法识别');
  return Number(envelope.version);
};

export const collectLocalDrafts = (): Record<string, string> => {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('本机草稿存储不可用');
  const entries: Record<string, string> = {};
  let bytes = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    backupEntry(key, raw);
    bytes += new TextEncoder().encode(key + raw).length;
    if (bytes > MAX_BACKUP_DRAFT_BYTES || Object.keys(entries).length >= 1000) throw new Error('本机草稿合计超过备份上限');
    entries[key] = raw;
  }
  return entries;
};

export const restoreLocalDrafts = (entries: Record<string, string>): void => {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('本机草稿存储不可用');
  if (!draftObject(entries) || Object.keys(entries).length > 1000) throw new Error('备份草稿格式无法识别');
  let bytes = 0;
  for (const [key, raw] of Object.entries(entries)) {
    if (typeof raw !== 'string') throw new Error('备份草稿内容必须为文本');
    backupEntry(key, raw);
    bytes += new TextEncoder().encode(key + raw).length;
    if (bytes > MAX_BACKUP_DRAFT_BYTES) throw new Error('备份草稿合计超过恢复上限');
    const existing = storage.getItem(key);
    if (existing && existing !== raw && backupEntry(key, existing) > 1) throw new Error('本机存在更新版本的草稿，已保留原件；请升级应用后恢复备份');
  }
  for (const [key, raw] of Object.entries(entries)) {
    if (storage.getItem(key) !== raw) storage.setItem(key, raw);
  }
};

export const recoverBackupDrafts = async () => {
  const recovered = await call(window.taskpilot.data.restoredDrafts());
  if (!recovered) return false;
  restoreLocalDrafts(recovered.entries);
  await call(window.taskpilot.data.acknowledgeDrafts(recovered.token));
  return true;
};

export type DraftState = { pending: boolean; restored: boolean; saved: boolean; conflict: boolean; error: string | null };
export type LocalDraft<T> = {
  value: Ref<T>;
  state: DraftState;
  restore: () => void;
  discard: () => void;
  clear: () => boolean;
  accept: (saved: T, baseline?: unknown) => void;
  stop: () => void;
};

export const draftKey = (identity: readonly (string | null)[]) => `${DRAFT_PREFIX}${JSON.stringify(identity)}`;

// A baseline fingerprint detects changed official content without storing another
// copy of the published requirement or course in the draft envelope.
export const draftFingerprint = (value: unknown) => {
  const text = JSON.stringify(value);
  let left = 2166136261;
  let right = 5381;
  for (let index = 0; index < text.length; index += 1) {
    left = Math.imul(left ^ text.charCodeAt(index), 16777619);
    right = Math.imul(right, 33) ^ text.charCodeAt(index);
  }
  return `${text.length}:${left >>> 0}:${right >>> 0}`;
};

export const draftObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const draftStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1000 && value.every((item) => typeof item === 'string');

export const createLocalDraft = <T extends object>(options: {
  key: string;
  initial: T;
  baseline?: unknown;
  validate: (value: unknown) => value is T;
}): LocalDraft<T> => {
  let initial = JSON.parse(JSON.stringify(options.initial)) as T;
  const value = ref<T>(JSON.parse(JSON.stringify(initial)) as T) as Ref<T>;
  const state = reactive<DraftState>({ pending: false, restored: false, saved: false, conflict: false, error: null });
  let baseline = draftFingerprint(options.baseline ?? initial);
  let previous: string | null = null;
  let candidate: T | null = null;
  let paused = false;
  let protectedEntry = false;

  const read = () => {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('本机存储不可用');
    const raw = storage.getItem(options.key);
    if (raw === null) return { storage, raw, envelope: null };
    if (raw.length > MAX_DRAFT_BYTES || new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES) throw new Error('已有草稿超过读取上限，已保留原件');
    const envelope: unknown = JSON.parse(raw);
    if (!draftObject(envelope) || typeof envelope.version !== 'number' || !Number.isInteger(envelope.version)) throw new Error('草稿格式无法识别，已保留原件');
    if (envelope.version > 1) {
      protectedEntry = true;
      throw new Error('草稿由更新版本创建，请升级应用后恢复；原件不会被覆盖或删除');
    }
    if (envelope.version !== 1 || typeof envelope.baseline !== 'string' || !options.validate(envelope.data)) throw new Error('草稿内容无法识别，已保留原件');
    return { storage, raw, envelope };
  };

  try {
    const loaded = read();
    previous = loaded.raw;
    if (loaded.envelope) {
      if (loaded.envelope.baseline === baseline) {
        candidate = loaded.envelope.data as T;
        state.pending = true;
      } else {
        state.conflict = true;
        state.error = '正式内容已更新，旧草稿没有载入。请丢弃旧草稿后再编辑，避免覆盖新内容。';
      }
    }
  } catch (error) {
    protectedEntry = true;
    state.error = `无法恢复本机草稿：${error instanceof Error ? error.message : '读取失败'}。当前输入仅在本次打开期间保留。`;
  }

  const clear = () => {
    try {
      const stored = read();
      if (protectedEntry) return false;
      if (stored.raw !== previous) throw new Error('本机草稿已在其他窗口更新，已保留该草稿');
      stored.storage.removeItem(options.key);
      previous = null;
      candidate = null;
      state.pending = false;
      state.restored = false;
      state.saved = false;
      state.conflict = false;
      state.error = null;
      return true;
    } catch (error) {
      state.error = `无法清除本机草稿：${error instanceof Error ? error.message : '存储失败'}。原件仍保留。`;
      return false;
    }
  };

  const restore = () => {
    if (!candidate || !state.pending) return;
    try {
      if (read().raw !== previous) throw new Error('本机草稿已在其他窗口更新，请重新打开表单');
    } catch (error) {
      state.error = `无法恢复草稿：${error instanceof Error ? error.message : '读取失败'}。原件仍保留。`;
      return;
    }
    paused = true;
    Object.assign(value.value, candidate);
    paused = false;
    candidate = null;
    state.pending = false;
    state.restored = true;
    state.saved = true;
  };
  const discard = () => {
    if (!clear()) return;
    paused = true;
    Object.assign(value.value, JSON.parse(JSON.stringify(initial)) as T);
    paused = false;
  };

  const persist = () => {
    if (paused || state.pending || state.conflict || protectedEntry) return;
    try {
      const stored = read();
      if (stored.raw !== previous) throw new Error('本机草稿已在其他窗口更新，请重新打开表单后恢复');
      if (draftFingerprint(value.value) === draftFingerprint(initial)) {
        clear();
        return;
      }
      if (!options.validate(value.value)) throw new Error('当前内容超出草稿支持的格式');
      const raw = JSON.stringify({ version: 1, baseline, data: value.value });
      if (new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES) throw new Error('草稿超过 256 KB，请减少内容');
      stored.storage.setItem(options.key, raw);
      previous = raw;
      state.saved = true;
      state.error = null;
    } catch (error) {
      state.error = `草稿未能保存到本机：${error instanceof Error ? error.message : '存储失败'}。请保留此页面并重试编辑。`;
    }
  };
  const accept = (saved: T, acceptedBaseline?: unknown) => {
    if (!clear()) return;
    initial = JSON.parse(JSON.stringify(saved)) as T;
    baseline = draftFingerprint(acceptedBaseline ?? initial);
    persist();
  };
  const stop = watch(value, persist, { deep: true, flush: 'sync' });
  return { value, state, restore, discard, clear, accept, stop };
};

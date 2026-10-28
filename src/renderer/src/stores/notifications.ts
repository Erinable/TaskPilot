// The notification center behind the top-bar bell: what needs the human,
// derived from the tasks and requirements stores, with read state kept on
// this machine in localStorage, one key per repository.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as notifications from '@/lib/notifications.ts';
import { useExecutionStore } from './execution.ts';
import { useRequirementsStore } from './requirements.ts';
import { useTasksStore } from './tasks.ts';

import { useRepositoryIdentityStore } from './repository_identity.ts';
export const READ_STORAGE_KEY = 'taskpilot.notifications.read';
// Package and requirement ids are only unique within a repository.
export const readStorageKey = (repositoryId: string | null) => (repositoryId ? `${READ_STORAGE_KEY}.${repositoryId}` : READ_STORAGE_KEY);

// localStorage is per-machine convenience data; anything unreadable is empty.
const loadRead = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch (error) {
    console.error('[notifications] read state unreadable', error);
    return [];
  }
};

export const useNotificationsStore = defineStore('notifications', () => {
  const tasks = useTasksStore();
  const requirements = useRequirementsStore();

  // ========== Items ==========
  const all = computed(() => notifications.deriveNotifications(tasks.tasks, requirements.items));
  const items = computed(() => all.value.slice(0, notifications.MAX_NOTIFICATIONS));

  // ========== Read state ==========
  let storageKey = READ_STORAGE_KEY;
  const readIds = ref(new Set(loadRead(storageKey)));
  // Called when a repository opens, so its own read state applies.
  const useRepository = (repositoryId: string | null) => {
    storageKey = readStorageKey(repositoryId);
    readIds.value = new Set(loadRead(storageKey));
  };
  const isRead = (id: string) => readIds.value.has(id);
  const unreadCount = computed(() => items.value.filter((item) => !readIds.value.has(item.id)).length);

  const saveRead = (ids: Iterable<string>) => {
    readIds.value = new Set(ids);
    localStorage.setItem(storageKey, JSON.stringify([...readIds.value]));
  };

  const markRead = (id: string) => {
    if (!readIds.value.has(id)) saveRead([...readIds.value, id]);
  };
  const markAllRead = () => saveRead([...readIds.value, ...items.value.map((item) => item.id)]);

  // Only after a successful reload: a failed or partial one would drop ids
  // whose notifications are still there.
  const pruneRead = () => {
    const kept = notifications.pruneRead(readIds.value, all.value);
    if (kept.length !== readIds.value.size) saveRead(kept);
  };

  // ========== Actions ==========
  const openItem = async (item: notifications.NotificationItem) => {
    markRead(item.id);
    if (item.target.kind === 'package') await useExecutionStore().open(item.target.id);
    else await requirements.open({ id: item.target.id });
  };

  // ========== Refresh ==========
  // A failed queue reload skips pruning. requirements.refreshList() logs its
  // ========== Refresh ==========
  const repositories = useRepositoryIdentityStore();
  let unsubscribe: (() => void) | null = null;
  let session = 0;
  let reading = false;
  let queued = false;

  const refresh = async () => {
    if (reading) {
      queued = true;
      return;
    }
    const token = session;
    reading = true;
    try {
      await Promise.all([tasks.reloadQueue(), requirements.refreshList()]);
      if (token === session) pruneRead();
    } catch (error) {
      console.error('[notifications] refresh failed', error);
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        await refresh();
      }
    }
  };

  const start = () => {
    if (unsubscribe) return;
    unsubscribe = window.taskpilot.state.onChanged((change) => {
      if (change.repositoryId !== repositories.currentId) return;
      if (change.domains.some((domain) => domain === 'packages' || domain === 'requirements')) refresh().catch((error) => console.error(error));
    });
    refresh().catch((error) => console.error(error));
  };

  const stop = () => {
    session += 1;
    queued = false;
    unsubscribe?.();
    unsubscribe = null;
  };

  return {
    // Items
    items,
    // Read state
    readIds,
    useRepository,
    isRead,
    unreadCount,
    markRead,
    markAllRead,
    // Actions
    openItem,
    // Refresh
    refresh,
    start,
    stop,
  };
});

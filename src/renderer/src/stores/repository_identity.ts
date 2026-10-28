// Repository identity without orchestration dependencies. Event consumers read
// this scope; only the repository switch store changes it.
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useRepositoryIdentityStore = defineStore('repositoryIdentity', () => {
  const currentId = ref<string | null>(null);
  return { currentId };
});

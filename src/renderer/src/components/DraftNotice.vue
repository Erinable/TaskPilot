<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import type { DraftState } from '@/lib/local_draft.ts';

defineProps<{ state: DraftState; busy?: boolean }>();
defineEmits<{ restore: []; discard: [] }>();
</script>

<template>
  <div
    v-if="state.pending || state.conflict || state.error || state.restored || state.saved"
    class="draft-notice"
    :class="{ warning: state.error }"
    :role="state.error ? 'alert' : 'status'"
    data-draft-notice
  >
    <AppIcon :name="state.error ? 'alert' : 'file'" />
    <p v-if="state.error">{{ state.error }}</p>
    <p v-else-if="state.pending">找到上次未提交的本机草稿。恢复后可以继续编辑，或丢弃后重新填写。</p>
    <p v-else-if="state.restored">已恢复上次未提交的本机草稿。后续修改会自动保存，提交成功后清除。</p>
    <p v-else>未提交内容已保存为本机草稿，关闭应用后可以恢复。</p>
    <div class="draft-notice-actions">
      <button v-if="state.pending" class="secondary-button small" type="button" data-action="restore-draft" :disabled="busy" @click="$emit('restore')">
        恢复草稿
      </button>
      <button
        v-if="state.pending || state.conflict || state.saved"
        class="link-button"
        type="button"
        data-action="discard-draft"
        :disabled="busy"
        @click="$emit('discard')"
      >
        丢弃草稿
      </button>
    </div>
  </div>
</template>

<style scoped>
.draft-notice {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-block: var(--space-3);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.draft-notice > .icon {
  flex-shrink: 0;
  margin-top: 3px;
}
.draft-notice p {
  flex: 1;
  min-width: 220px;
  margin: 0;
}
.draft-notice.warning {
  color: var(--danger);
}
.draft-notice-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
</style>

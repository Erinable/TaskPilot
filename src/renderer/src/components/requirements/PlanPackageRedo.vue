<script setup lang="ts">
// Redoing one package of the plan under review: the developer says what is
// wrong and Product Lead rewrites only this package.
import { ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';

export type RedoView = {
  // This package is being redone right now.
  running: boolean;
  // Another redo or step runs, so this one cannot start.
  disabled: boolean;
  // The last redo of this package failed with this text.
  failed: string | null;
  // Earlier packages it depends on that were redone after it was written.
  staleDependencies: number[];
};

defineProps<{ index: number; redo: RedoView }>();
const emit = defineEmits<{ redo: [comment: string, done: (started: boolean) => void] }>();

const MAX_COMMENT = 1000;
const editing = ref(false);
const comment = ref('');
const sending = ref(false);
const submit = () => {
  sending.value = true;
  emit('redo', comment.value.trim(), (started) => {
    sending.value = false;
    if (!started) return;
    editing.value = false;
    comment.value = '';
  });
};
</script>

<template>
  <div class="plan-redo" data-plan-redo>
    <p v-if="redo.running" class="plan-redo-status" role="status">
      <AppIcon name="spinner" class="spin" />
      Product Lead 正在重做这个工作包，其他工作包不会变。
    </p>
    <template v-else>
      <p v-if="redo.failed" class="plan-redo-status failed" role="status">
        <AppIcon name="alert" />
        {{ `重做没有完成：${redo.failed}。计划保持原样。` }}
      </p>
      <form v-if="editing" class="plan-redo-form" novalidate @submit.prevent="submit">
        <label :for="`planRedo${index}`">哪里不对？说清楚要怎么改，只重做这个工作包</label>
        <el-input
          :id="`planRedo${index}`"
          v-model="comment"
          type="textarea"
          :rows="2"
          :maxlength="MAX_COMMENT"
          placeholder="例如：范围太大了，只做登录，注册放到别的包"
        />
        <div class="plan-redo-actions">
          <button class="secondary-button small" type="button" :disabled="sending" @click="editing = false">取消</button>
          <button class="primary-button small" type="submit" :disabled="!comment.trim() || sending || redo.disabled" :aria-busy="sending">
            <AppIcon :name="sending ? 'spinner' : 'refresh'" :class="{ spin: sending }" />
            重做这个工作包
          </button>
        </div>
      </form>
      <button v-else class="link-button" type="button" :disabled="redo.disabled" data-action="redo-package" @click="editing = true">
        <AppIcon name="refresh" />
        只重做这个工作包
      </button>
    </template>
  </div>
</template>

<style scoped>
.plan-redo {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.plan-redo-status {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.plan-redo-status.failed {
  color: var(--danger);
}
.plan-redo-form {
  display: grid;
  gap: var(--space-2);
}
.plan-redo-form label {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.plan-redo-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
</style>

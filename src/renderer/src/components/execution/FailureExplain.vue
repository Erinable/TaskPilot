<script setup lang="ts">
// A failed check explained in plain words, with the raw output folded below.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { explainFailure } from '@/lib/failure_explain.ts';
import type { FailureInput } from '@/lib/failure_explain.ts';

const props = defineProps<{ input: FailureInput; outputLabel?: string }>();

const explanation = computed(() => explainFailure(props.input));
</script>

<template>
  <div v-if="explanation" class="failure-explain" role="note">
    <AppIcon name="info" class="failure-explain-icon" />
    <div>
      <strong>{{ explanation.title }}</strong>
      <p><InlineCode :text="explanation.detail" /></p>
    </div>
  </div>
  <details v-if="input.output.trim()" class="verify-output-details" :open="!explanation">
    <summary>{{ outputLabel ?? '查看原始输出' }}</summary>
    <pre class="verify-output">{{ input.output.trim() }}</pre>
  </details>
</template>

<style scoped>
.failure-explain {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  color: var(--text-secondary);
  background: var(--warning-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.failure-explain-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--warning);
}
.failure-explain strong {
  display: block;
  color: var(--text);
  font-size: var(--text-md);
}
.failure-explain p {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  line-height: 1.6;
}
.verify-output-details {
  margin-top: var(--space-3);
}
.verify-output-details summary {
  color: var(--text-tertiary);
  font-size: var(--text-sm);
  cursor: pointer;
}
.verify-output-details .verify-output {
  margin-top: var(--space-2);
}
</style>

<script setup lang="ts">
import { ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { diffLineKind } from '@/lib/review_model.ts';
import type { DiffLineKind } from '@/lib/review_model.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ taskId: string; change: ipc.FileChange }>();

const expanded = ref(false);
// Null until first expanded: the patch is fetched on demand so opening the page stays cheap.
const lines = ref<{ kind: DiffLineKind; text: string }[] | null>(null);

const load = async () => {
  lines.value = [{ kind: 'meta', text: '加载中…' }];
  try {
    const patch = await call(window.taskpilot.diff.file(props.taskId, props.change.path));
    const parsed = patch
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ({ kind: diffLineKind(line), text: line }));
    lines.value = parsed.length ? parsed : [{ kind: 'meta', text: '无文本差异' }];
  } catch (error) {
    console.error(error);
    lines.value = [{ kind: 'del', text: describeError(error) }];
  }
};

const toggle = () => {
  expanded.value = !expanded.value;
  if (!expanded.value || lines.value) return;
  if (props.change.binary) lines.value = [{ kind: 'meta', text: '二进制文件' }];
  else load().catch((error) => console.error(error));
};
</script>

<template>
  <div class="diff-file">
    <button class="diff-file-header" type="button" :aria-expanded="expanded ? 'true' : 'false'" @click="toggle">
      <AppIcon name="chevron-right" class="diff-chevron" />
      <span class="scope-path">{{ change.path }}</span>
      <span v-if="change.untracked" class="scope-tag new">新文件</span>
      <span v-if="!change.binary" class="scope-churn">
        <span class="added">+{{ change.added }}</span>
        <span class="removed">-{{ change.removed }}</span>
      </span>
    </button>
    <div class="diff-body" :hidden="!expanded">
      <div v-for="(line, index) in lines ?? []" :key="index" class="diff-line" :class="line.kind">{{ line.text }}</div>
    </div>
  </div>
</template>

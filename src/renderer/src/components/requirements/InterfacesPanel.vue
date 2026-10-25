<script setup lang="ts">
// Architect's interface summary, collapsed by default: it is what Product
// Lead planned against, so the user can check it, but it isn't the main
// thing on the page.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { SKIP_LABELS } from './requirement_model.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const props = defineProps<{ info: requirementTypes.RequirementInterfaces }>();

const headline = computed(() => {
  const info = props.info;
  if (info.summary) return `读取了 ${info.read.length} 个文件，整理出 ${info.summary.modules.length} 个模块的接口`;
  if (info.error) return `没能整理接口摘要（${describeErrorInfo(info.error)}），Product Lead 只按文件列表规划`;
  return '没有需要读取的代码';
});

const modules = computed(() => props.info.summary?.modules ?? []);

const sections = computed(() =>
  [
    { title: '仓库约定', entries: props.info.summary?.conventions ?? [], className: '' },
    { title: '不确定或缺失', entries: props.info.summary?.gaps ?? [], className: 'gaps' },
    {
      title: '未读取',
      entries: (props.info.skipped ?? []).map((skipped) => `${skipped.path}（${SKIP_LABELS[skipped.reason] ?? skipped.reason}）`),
      className: 'skipped',
    },
  ].filter((section) => section.entries.length),
);

const hasBody = computed(() => modules.value.length > 0 || sections.value.length > 0);
</script>

<template>
  <details class="interfaces glass">
    <summary>
      <span class="interfaces-label">
        <span class="agent-avatar arch">AR</span>
        <strong>Architect</strong>
      </span>
      <span class="interfaces-headline">{{ headline }}</span>
    </summary>
    <div v-if="hasBody" class="interfaces-body">
      <div v-for="mod in modules" :key="mod.path" class="interface-module">
        <div class="interface-path">
          <AppIcon name="file" />
          {{ mod.path }}
        </div>
        <p class="interface-purpose">{{ mod.purpose }}</p>
        <pre v-if="mod.members.length" class="interface-members">{{ mod.members.map((member) => member.signature).join('\n') }}</pre>
        <p v-if="mod.dependsOn.length" class="interface-deps">{{ `依赖 ${mod.dependsOn.join('、')}` }}</p>
        <ul v-if="mod.notes.length" class="interface-notes">
          <li v-for="(note, index) in mod.notes" :key="index">{{ note }}</li>
        </ul>
      </div>
      <div v-for="section in sections" :key="section.title" class="interface-section" :class="section.className">
        <h4>{{ section.title }}</h4>
        <ul>
          <li v-for="(entry, index) in section.entries" :key="index">{{ entry }}</li>
        </ul>
      </div>
    </div>
  </details>
</template>

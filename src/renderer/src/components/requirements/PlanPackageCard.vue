<script setup lang="ts">
// One proposed work package in Product Lead's plan.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import DifficultyChip from '@/components/DifficultyChip.vue';
import InlineCode from '@/components/InlineCode.vue';
import { modeLabel } from '@/lib/execution_mode.ts';
import { PRIORITY_LABELS } from './requirement_model.ts';
import type { IconName } from '@/lib/icons.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const props = defineProps<{ pkg: requirementTypes.PlanPackage; index: number }>();

// The module tag first, then the rest without repeating it.
const tags = computed(() => [props.pkg.module, ...props.pkg.tags.filter((tag) => tag !== props.pkg.module)]);
</script>

<template>
  <article class="plan-package glass">
    <div class="plan-package-head">
      <!-- pkg.icon is validated by the main process; an unknown name renders blank. -->
      <span class="task-state" :class="`priority-${pkg.priority}`"><AppIcon :name="pkg.icon as IconName" /></span>
      <div class="plan-package-titles">
        <span class="plan-package-index">{{ `工作包 ${index + 1}` }}</span>
        <h3>{{ pkg.title }}</h3>
        <p>{{ pkg.description }}</p>
        <p v-if="pkg.dependsOn?.length" class="plan-depends">
          <AppIcon name="clock" />
          {{ `先完成工作包 ${pkg.dependsOn.join('、')} 才能开始` }}
        </p>
      </div>
      <div class="plan-package-meta">
        <span class="priority">
          <span class="priority-dot" :class="pkg.priority"></span>
          {{ PRIORITY_LABELS[pkg.priority] }}
        </span>
        <span class="task-time">
          <AppIcon name="clock" />
          {{ `${pkg.estimateHours}h` }}
        </span>
      </div>
    </div>
    <div class="task-tags">
      <span v-for="(tag, tagIndex) in tags" :key="tagIndex" class="tag">{{ tag }}</span>
    </div>
    <DifficultyChip :difficulty="pkg.difficulty" detailed class="plan-difficulty" />
    <p v-if="pkg.recommendedMode" class="plan-mode" data-plan-mode>
      <AppIcon :name="pkg.recommendedMode.mode === 'practice' ? 'flask' : 'sparkle'" />
      <strong>建议{{ modeLabel(pkg.recommendedMode.mode) }}</strong>
      <span>{{ pkg.recommendedMode.reason }}</span>
    </p>
    <div class="plan-section">
      <h4>执行指令</h4>
      <ol class="plan-steps">
        <li v-for="(step, stepIndex) in pkg.steps" :key="stepIndex"><InlineCode :text="step" /></li>
      </ol>
    </div>
    <div class="plan-section">
      <h4>文件范围</h4>
      <ul class="plan-scope">
        <li v-for="file in pkg.fileScope" :key="file">
          <AppIcon name="file" />
          {{ file }}
        </li>
      </ul>
    </div>
    <div class="plan-section">
      <h4>验收条件</h4>
      <ul class="plan-acceptance">
        <li v-for="(criterion, criterionIndex) in pkg.acceptance" :key="criterionIndex">
          <AppIcon name="check-circle" />
          {{ criterion.text }}
          <small v-if="criterion.test">
            <AppIcon name="flask" />
            {{ criterion.test }}
          </small>
        </li>
      </ul>
    </div>
  </article>
</template>

<style scoped>
.plan-mode {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.plan-depends {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  margin-top: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.plan-depends .icon {
  width: 12px;
  height: 12px;
}
</style>

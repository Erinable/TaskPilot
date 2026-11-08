<script setup lang="ts">
// One proposed work package in Product Lead's plan. While the plan is under
// review it carries the redo form (PlanPackageRedo.vue).
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import DifficultyChip from '@/components/DifficultyChip.vue';
import InlineCode from '@/components/InlineCode.vue';
import { modeLabel } from '@/lib/execution_mode.ts';
import { PRIORITY_LABELS } from './requirement_model.ts';
import PlanPackageRedo from './PlanPackageRedo.vue';
import type { RedoView } from './PlanPackageRedo.vue';
import type { IconName } from '@/lib/icons.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const props = defineProps<{
  pkg: requirementTypes.PlanPackage;
  index: number;
  // Set while the plan is under review; absent on a published plan.
  redo?: RedoView;
}>();
const emit = defineEmits<{ redo: [comment: string, done: (started: boolean) => void] }>();

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
        <p v-if="redo?.staleDependencies.length" class="plan-stale" data-plan-stale>
          <AppIcon name="alert" />
          {{ `它依赖的工作包 ${redo.staleDependencies.join('、')} 重做过，这个包的步骤可能要跟着调整` }}
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
    <PlanPackageRedo v-if="redo" :index="index" :redo="redo" @redo="(comment, done) => emit('redo', comment, done)" />
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
.plan-stale {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  margin-top: var(--space-1);
  color: var(--warning);
  font-size: var(--text-xs);
}
.plan-stale .icon,
.plan-depends .icon {
  width: 12px;
  height: 12px;
}
</style>

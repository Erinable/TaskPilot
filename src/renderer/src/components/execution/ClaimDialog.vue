<script setup lang="ts">
// Starting a package: who writes the code. Product Lead's recommendation is
// preselected and its reason shown; the choice holds until the package is
// released back to the queue.
import AppIcon from '@/components/AppIcon.vue';
import { MODE_OPTIONS } from '@/lib/execution_mode.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

defineProps<{ task: packageTypes.TaskView }>();

const execution = useExecutionStore();

const confirm = () => execution.confirmClaim().catch((error) => console.error(error));
</script>

<template>
  <el-dialog v-model="execution.claimOpen" class="task-modal glass-strong claim-dialog" :show-close="false" aria-labelledby="claimTitle" append-to-body>
    <button class="icon-button small modal-close" type="button" aria-label="关闭" @click="execution.closeClaim()"><AppIcon name="x" /></button>
    <div class="modal-badge"><AppIcon name="play" /></div>
    <div class="modal-kicker">开始执行</div>
    <h2 id="claimTitle">这个工作包谁来写？</h2>
    <p v-if="task.recommendedMode" class="modal-intro" data-recommendation>
      Product Lead 建议「{{ MODE_OPTIONS.find((option) => option.mode === task.recommendedMode?.mode)?.label }}」：{{ task.recommendedMode.reason }}
    </p>
    <p v-else class="modal-intro">选一种方式。放回队列之前不能换。</p>

    <el-radio-group v-model="execution.claimMode" class="claim-modes" aria-label="执行方式">
      <el-radio v-for="option in MODE_OPTIONS" :key="option.mode" :value="option.mode" border class="claim-mode" :data-mode="option.mode">
        <span class="claim-mode-label">
          {{ option.label }}
          <small v-if="task.recommendedMode?.mode === option.mode" class="claim-mode-tag">推荐</small>
        </span>
        <span class="claim-mode-detail">{{ option.detail }}</span>
      </el-radio>
    </el-radio-group>

    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="execution.closeClaim()">取消</button>
      <button class="primary-button" type="button" data-action="confirm-claim" @click="confirm">
        <AppIcon name="play" />
        开始
      </button>
    </div>
  </el-dialog>
</template>

<style>
/* Teleported, so not scoped: the legacy modal draws its own header and padding. */
.el-dialog.claim-dialog {
  position: relative;
  padding: 28px 30px 26px;
}
.el-dialog.claim-dialog .el-dialog__header {
  display: none;
}
.el-dialog.claim-dialog .el-dialog__body {
  padding: 0;
}
.claim-modes {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.claim-modes .el-radio.claim-mode {
  height: auto;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  align-items: flex-start;
  white-space: normal;
}
.claim-mode .el-radio__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.claim-mode-label {
  font-weight: 600;
}
.claim-mode-tag {
  margin-left: var(--space-2);
  color: var(--accent);
  font-size: var(--text-xs);
}
.claim-mode-detail {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
</style>

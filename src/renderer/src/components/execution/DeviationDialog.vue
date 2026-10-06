<script setup lang="ts">
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();
const noteInput = ref<{ focus: () => void } | null>(null);

// The "none" choices use '' as a sentinel; the form keeps null.
const stepOptions = computed(() => props.task.steps.map((step, index) => ({ value: String(index), label: `指令 ${index + 1}：${step.replace(/`/g, '')}` })));
const stepValue = computed({
  get: () => (execution.deviationForm.stepIndex === null ? '' : String(execution.deviationForm.stepIndex)),
  set: (value: string) => {
    execution.deviationForm.stepIndex = value === '' ? null : Number(value);
  },
});
const fileValue = computed({
  get: () => execution.deviationForm.filePath ?? '',
  set: (value: string) => {
    execution.deviationForm.filePath = value || null;
  },
});

const focusNote = () => noteInput.value?.focus();

const submit = () => {
  execution
    .submitDeviation()
    .then((filled) => {
      if (!filled) focusNote();
    })
    .catch((error) => console.error(error));
};
</script>

<template>
  <el-dialog
    v-model="execution.deviationOpen"
    class="task-modal glass-strong deviation-dialog"
    :show-close="false"
    aria-labelledby="deviationTitle"
    append-to-body
    @opened="focusNote"
  >
    <button class="icon-button small modal-close" type="button" aria-label="关闭" @click="execution.closeDeviationForm()"><AppIcon name="x" /></button>
    <div class="modal-badge"><AppIcon name="flag" /></div>
    <div class="modal-kicker">执行中发现偏差</div>
    <h2 id="deviationTitle">报告偏差</h2>
    <p class="modal-intro">设计和代码对不上时，在这里说明。提交后工作包会交回 AI 团队重新评估，不要自行偏离指令。</p>

    <label class="field-label" for="deviationStep">相关指令（可选）</label>
    <el-select id="deviationStep" v-model="stepValue" class="w-full">
      <el-option value="" label="不指向特定指令" />
      <el-option v-for="option in stepOptions" :key="option.value" :value="option.value" :label="option.label" />
    </el-select>

    <label class="field-label" for="deviationFile">相关文件（可选）</label>
    <el-select id="deviationFile" v-model="fileValue" class="w-full">
      <el-option value="" label="不指向特定文件" />
      <el-option v-for="filePath in task.fileScope" :key="filePath" :value="filePath" :label="filePath" />
    </el-select>

    <label class="field-label" for="deviationNote">偏差说明</label>
    <el-input
      id="deviationNote"
      ref="noteInput"
      v-model="execution.deviationForm.note"
      type="textarea"
      :rows="4"
      placeholder="例如：ADR-014 要求 application 层不依赖 infrastructure，但现有 TokenService 已被 3 处直接引用。"
    />

    <div class="modal-actions">
      <button class="secondary-button" type="button" @click="execution.closeDeviationForm()">取消</button>
      <button class="primary-button" type="button" @click="submit">
        <AppIcon name="send" />
        提交偏差
      </button>
    </div>
  </el-dialog>
</template>

<style>
/* Teleported, so not scoped: the legacy modal draws its own header and padding. */
.el-dialog.deviation-dialog {
  position: relative;
  padding: 28px 30px 26px;
}
.el-dialog.deviation-dialog .el-dialog__header {
  display: none;
}
.el-dialog.deviation-dialog .el-dialog__body {
  padding: 0;
}
</style>

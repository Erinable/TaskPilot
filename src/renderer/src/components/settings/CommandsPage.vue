<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import { FIELD_INPUTS, useSettingsStore } from '@/stores/settings.ts';
import FieldStatus from './FieldStatus.vue';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

const settings = useSettingsStore();

const CHECKS: { kind: workspaceTypes.CheckKind; label: string; icon: IconName; hint: string | null; placeholder: string; statusId: string }[] = [
  {
    kind: 'test',
    label: '测试',
    icon: 'flask',
    hint: '单元测试。输出 TAP 或 node --test 格式，或配置 JUnit 报告时，结果会关联到验收条件',
    placeholder: 'npm test',
    statusId: 'statusTest',
  },
  { kind: 'lint', label: 'Lint', icon: 'wand', hint: null, placeholder: 'npm run lint', statusId: 'statusLint' },
  { kind: 'build', label: 'Build', icon: 'box', hint: null, placeholder: 'npm run build', statusId: 'statusBuild' },
  { kind: 'smoke', label: '冒烟测试', icon: 'rocket', hint: '构建后快速确认应用能启动、核心路径可用', placeholder: 'npm run smoke', statusId: 'statusSmoke' },
];
const STAGES: { value: workspaceTypes.CheckStage; label: string }[] = [
  { value: 'submit', label: '提交前运行' },
  { value: 'step', label: '仅手动运行' },
];
</script>

<template>
  <header class="settings-page-header">
    <h2>验证命令</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      本机配置 · 不写入仓库
    </span>
  </header>
  <p class="settings-page-intro">
    执行页的按钮运行这些命令；标为「提交前运行」的会在 QA 审查前自动运行，并在领取工作包时于基线上先跑一次，用来区分既有失败和新引入的失败。TaskPilot
    只会运行这里配置的命令，从不执行工作包里出现的命令。
  </p>
  <div v-if="settings.workspaceDraft" class="settings-card glass">
    <div v-for="check in CHECKS" :key="check.kind" class="setting-row stacked check-row">
      <label class="setting-label" :for="FIELD_INPUTS[check.kind]">
        <strong>
          <AppIcon :name="check.icon" />
          {{ check.label }}
        </strong>
        <small v-if="check.hint">{{ check.hint }}</small>
      </label>
      <el-input
        :id="FIELD_INPUTS[check.kind]"
        v-model="settings.workspaceDraft.commands[check.kind]"
        class="mono-input command-line"
        :data-kind="check.kind"
        spellcheck="false"
        autocomplete="off"
        :placeholder="check.placeholder"
        :aria-describedby="check.statusId"
        :aria-invalid="String(settings.statuses[check.kind].tone === 'error')"
      />
      <FieldStatus :id="check.statusId" :status="settings.statuses[check.kind]" />
      <div class="check-options" role="group" :aria-label="`${check.label}的运行方式`">
        <label class="check-option">
          <span>运行时机</span>
          <el-select v-model="settings.workspaceDraft.options[check.kind].stage" class="stage-select" size="small" :aria-label="`${check.label}的运行时机`">
            <el-option v-for="stage in STAGES" :key="stage.value" :value="stage.value" :label="stage.label" />
          </el-select>
        </label>
        <el-checkbox v-model="settings.workspaceDraft.options[check.kind].blocking" class="check-option">失败时拒绝</el-checkbox>
        <label class="check-option grow">
          <span>JUnit 报告</span>
          <el-input
            v-model="settings.workspaceDraft.options[check.kind].reportPath"
            class="mono-input"
            size="small"
            spellcheck="false"
            autocomplete="off"
            :placeholder="`留空则解析输出，如 .taskpilot/reports/${check.kind}.xml`"
          />
        </label>
      </div>
    </div>
  </div>
  <p class="settings-note">
    <AppIcon name="info" />
    <span>
      命令直接启动，不经过 shell：
      <code>&amp;&amp;</code>
      、
      <code>|</code>
      、重定向和环境变量展开都不可用。需要组合多个步骤时，请写成
      <code>package.json</code>
      里的脚本。留空表示不配置。
    </span>
  </p>
</template>

<style scoped>
.mono-input :deep(input) {
  font-family: var(--font-mono);
}
.stage-select {
  width: 132px;
}
</style>

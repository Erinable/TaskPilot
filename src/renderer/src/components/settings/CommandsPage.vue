<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import StepCard from './StepCard.vue';

const settings = useSettingsStore();

const view = computed(() => settings.workspaceView);
const project = computed(() => view.value?.project ?? { status: 'missing' as const });
const presetLabel = (id: string | null) => (id ? (view.value?.presets.find((preset) => preset.id === id)?.label ?? id) : '不用预设');
// The first recognised language that has a preset is recommended.
const recommended = computed(() => view.value?.detected.find((entry) => entry.preset) ?? null);
const unsupported = computed(() => view.value?.detected.filter((entry) => !entry.preset) ?? []);
const missingTools = computed(() => settings.tools.filter((tool) => !tool.version));

// Steps grouped by what happens to them, so the page reads top-down:
// what checks a submission, what is a button, what is not set up.
const groups = computed(() => {
  const steps = view.value?.steps ?? [];
  const running = (stage: string) => steps.filter((step) => step.effective?.stage === stage).map((step) => step.id);
  return [
    { id: 'submit', title: '提交前自动运行', note: 'QA 审查前自动跑，领取工作包时先在基线上跑一次', steps: running('submit') },
    { id: 'manual', title: '手动运行', note: '在执行页点按钮运行', steps: running('step') },
    { id: 'skipped', title: '未配置', note: '没有命令，会跳过', steps: steps.filter((step) => !step.effective).map((step) => step.id) },
  ].filter((group) => group.steps.length);
});

const create = (preset: string) => {
  settings.createProject(preset).catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>检查步骤</h2>
    <span class="scope-badge">
      <AppIcon name="terminal" />
      项目配置 + 本机覆盖
    </span>
  </header>
  <p class="settings-page-intro">
    TaskPilot 用这些步骤检查改动。每一步的命令先看本机设置，再看仓库里的 taskpilot.toml，最后用预设补齐。点开一步可以查看或修改。TaskPilot
    只会运行这里的命令，从不执行工作包里出现的命令。
  </p>

  <div v-if="view" id="projectFile" class="settings-card glass project-file" :class="project.status">
    <AppIcon :name="project.status === 'ok' ? 'check-circle' : project.status === 'invalid' ? 'alert' : 'file'" class="project-icon" />
    <div class="project-body">
      <template v-if="project.status === 'ok'">
        <strong>taskpilot.toml</strong>
        <p>
          预设：
          <span class="scope-badge">{{ presetLabel(project.preset) }}</span>
          没在文件和本机里设置的步骤，用预设的默认命令。
        </p>
      </template>
      <template v-else-if="project.status === 'invalid'">
        <strong class="warn-text">taskpilot.toml 有错误，暂时没有使用</strong>
        <p role="alert">
          <code>{{ project.error.message }}</code>
        </p>
        <p>改好文件后重新打开这个页面。在这之前只运行本机设置的步骤。</p>
      </template>
      <template v-else>
        <strong>仓库里还没有 taskpilot.toml</strong>
        <p v-if="recommended">检测到 {{ recommended.manifest }}，推荐「{{ presetLabel(recommended.preset) }}」预设，它会按 package.json 的脚本补齐各步命令。</p>
        <p v-else>现在只运行本机设置的步骤。创建后可以把检查配置提交到仓库，团队共用。</p>
      </template>
      <p v-for="entry in unsupported" :key="entry.manifest" class="project-note">
        检测到 {{ entry.manifest }}（{{ entry.language }}），这个语言还没有预设，可以在 taskpilot.toml 里手动写步骤。
      </p>
      <div v-for="tool in missingTools" :key="tool.command" class="project-tool" role="status">
        <AppIcon name="alert" />
        <span>找不到 {{ tool.command }}，TaskPilot 不会自动安装。可以在终端运行：</span>
        <code>{{ tool.install }}</code>
      </div>
    </div>
    <button v-if="project.status === 'missing'" id="createProject" class="primary-button small" type="button" @click="create(recommended?.preset ?? 'none')">
      <AppIcon name="plus" />
      {{ recommended ? '用推荐预设创建' : '创建 taskpilot.toml' }}
    </button>
  </div>

  <template v-if="settings.workspaceDraft && view">
    <section v-for="group in groups" :key="group.id" class="step-group" :data-step-group="group.id">
      <h3 class="settings-section-title">
        {{ group.title }}
        <small>{{ group.note }}</small>
      </h3>
      <div class="settings-card glass step-list">
        <StepCard v-for="id in group.steps" :id="id" :key="id" />
      </div>
    </section>
  </template>
  <p class="settings-note">
    <AppIcon name="info" />
    <span>
      命令直接启动，不经过 shell：
      <code>&amp;&amp;</code>
      、
      <code>|</code>
      、重定向和环境变量展开都不可用。一步要跑多条命令时逐条添加，按顺序运行，遇到失败就停。
    </span>
  </p>
</template>

<style scoped>
.project-file {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 14px 16px;
  font-size: var(--text-sm);
}
.project-file.invalid {
  border-color: var(--warning);
}
.project-icon {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  color: var(--text-muted);
}
.project-file.ok .project-icon {
  color: var(--success);
}
.project-file.invalid .project-icon {
  color: var(--warning);
}
.project-body {
  display: grid;
  flex: 1;
  gap: 6px;
  min-width: 0;
}
.project-body p {
  margin: 0;
  color: var(--text-secondary);
}
.project-body code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.project-note {
  color: var(--text-muted) !important;
}
.project-tool {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--warning);
}
.project-tool .icon {
  width: 14px;
  height: 14px;
}
.step-group {
  display: grid;
  gap: var(--space-2);
}
.settings-section-title small {
  margin-left: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 400;
}
.step-list {
  padding: 0;
  overflow: hidden;
}
/* Room below the last step, so the save bar never covers it. */
.settings-note {
  margin-bottom: 72px;
}
</style>

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

const create = (preset: string) => {
  settings.createProject(preset).catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>检查步骤</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      本机覆盖 · taskpilot.toml 随仓库
    </span>
  </header>
  <p class="settings-page-intro">
    TaskPilot
    只认这几个固定步骤：环境准备、构建、格式检查、代码检查、类型检查、测试、覆盖率，外加项目自定义的步骤。每步跑什么命令，先看本机设置，再看仓库根目录的
    taskpilot.toml，最后用它指定的预设补齐；都没有就跳过。标为「提交前运行」的步骤会在 QA 审查前自动运行，并在领取工作包时先在基线上跑一次。TaskPilot
    从不执行工作包里出现的命令。
  </p>

  <div v-if="view" id="projectFile" class="settings-card glass project-file">
    <template v-if="project.status === 'ok'">
      <p>
        <AppIcon name="check-circle" />
        仓库里有 taskpilot.toml，预设：
        <strong>{{ presetLabel(project.preset) }}</strong>
      </p>
    </template>
    <template v-else-if="project.status === 'invalid'">
      <p class="warn-text" role="alert">
        <AppIcon name="alert" />
        taskpilot.toml 有错误，已忽略，只用本机设置：
        <code>{{ project.error.message }}</code>
      </p>
    </template>
    <template v-else>
      <p>
        <AppIcon name="info" />
        仓库里还没有 taskpilot.toml。现在只运行本机设置的步骤。
      </p>
      <p v-if="recommended" class="project-recommend">
        检测到 {{ recommended.manifest }}，推荐「{{ presetLabel(recommended.preset) }}」预设。
        <button id="createProject" class="secondary-button small" type="button" @click="create(recommended.preset as string)">
          <AppIcon name="plus" />
          创建 taskpilot.toml
        </button>
      </p>
      <p v-else class="project-recommend">
        <button id="createProject" class="secondary-button small" type="button" @click="create('none')">
          <AppIcon name="plus" />
          创建空的 taskpilot.toml
        </button>
      </p>
    </template>
    <p v-for="entry in unsupported" :key="entry.manifest" class="project-note">
      检测到 {{ entry.manifest }}（{{ entry.language }}），这个语言的预设还没有，可以在 taskpilot.toml 里手动写步骤。
    </p>
    <div v-if="missingTools.length" class="project-tools" role="status">
      <p v-for="tool in missingTools" :key="tool.command">
        <AppIcon name="alert" />
        在当前 PATH 中找不到 {{ tool.command }}。TaskPilot 不会自动安装，可以运行：
        <code>{{ tool.install }}</code>
      </p>
    </div>
  </div>

  <div v-if="settings.workspaceDraft && view" class="settings-card glass">
    <StepCard v-for="step in view.steps" :id="step.id" :key="step.id" />
  </div>
  <p class="settings-note">
    <AppIcon name="info" />
    <span>
      命令直接启动，不经过 shell：
      <code>&amp;&amp;</code>
      、
      <code>|</code>
      、重定向和环境变量展开都不可用。一步要跑多条命令时，逐条添加，按顺序运行、遇到失败就停。
    </span>
  </p>
</template>

<style scoped>
.project-file {
  display: grid;
  gap: var(--space-2);
  padding: 12px 16px;
  font-size: var(--text-sm);
}
.project-file p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
}
.project-file code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.project-note,
.project-tools {
  color: var(--text-muted);
}
</style>

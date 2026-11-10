<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import { useDataManagementStore } from '@/stores/data_management.ts';

const settings = useSettingsStore();
const data = useDataManagementStore();

const resetSummary = computed(() => {
  const packages = settings.dataInfo?.packages;
  if (!packages) return '清除领取状态、基线、步骤进度和偏差记录。工作区配置和偏好设置保留。';
  return `清除领取状态、基线、步骤进度和偏差记录（当前 ${packages.total} 个工作包，${packages.claimed} 个已领取，${packages.deviations} 条偏差）。工作区配置和偏好设置保留。`;
});
const resetDisabled = computed(() => Boolean(settings.dataInfo && settings.dataInfo.packages.claimed === 0 && settings.dataInfo.packages.deviations === 0));

const onReveal = () => {
  settings.revealData().catch((error) => console.error(error));
};
const onReset = () => {
  settings.resetProgress().catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>数据</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      仅本设备
    </span>
  </header>
  <h3 class="settings-section-title">存储位置</h3>
  <div class="settings-card glass">
    <div class="setting-row stacked">
      <div class="path-header">
        <div class="setting-label">
          <strong>数据目录</strong>
          <small>工作区配置、偏好设置和工作包进度都保存在这里</small>
        </div>
        <button id="revealData" class="secondary-button small" type="button" @click="onReveal">
          <AppIcon name="folder" />
          在访达中显示
        </button>
      </div>
      <code id="dataDir" class="path-chip">{{ settings.dataInfo?.configDir }}</code>
      <ul id="dataFiles" class="file-list">
        <li v-for="file in settings.dataInfo?.files ?? []" :key="file">
          <AppIcon name="file" />
          <code>{{ file }}</code>
        </li>
      </ul>
    </div>
  </div>
  <h3 class="settings-section-title">备份与恢复</h3>
  <div class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>保存可校验的本地备份</strong>
        <small>包含需求、进度、课程、私有 lab、掌握度、默认笔记和未提交草稿。项目源代码与外部笔记目录需要另行备份。备份含私人内容，请妥善保管。</small>
      </div>
      <div class="data-actions">
        <button class="secondary-button small" type="button" :disabled="data.busy || Boolean(data.rollbackPath)" @click="data.backup">
          {{ data.busy ? '正在处理…' : '创建备份…' }}
        </button>
        <button class="secondary-button small" type="button" :disabled="data.busy || Boolean(data.rollbackPath)" @click="data.chooseRestore">
          选择备份恢复…
        </button>
      </div>
      <p v-if="data.lastBackup" class="data-detail">
        最近备份：
        <code>{{ data.lastBackup.path }}</code>
      </p>
      <p v-if="data.lastBackup?.externalNotes" class="data-detail">
        外部笔记未打包，请另行备份：
        <code>{{ data.lastBackup.externalNotes }}</code>
      </p>
      <div v-if="data.preview" class="backup-preview">
        <strong>备份校验通过</strong>
        <dl class="backup-facts">
          <dt>创建时间</dt>
          <dd>{{ data.preview.createdAt }}</dd>
          <dt>应用版本</dt>
          <dd>{{ data.preview.appVersion ?? '未知' }}</dd>
          <dt>内容</dt>
          <dd>{{ data.preview.files }} 个文件，{{ data.preview.drafts }} 份草稿</dd>
          <dt>来源</dt>
          <dd>
            <code>{{ data.preview.path }}</code>
          </dd>
        </dl>
        <p v-if="data.preview.externalNotes" class="data-detail">
          原外部笔记目录：
          <code>{{ data.preview.externalNotes }}</code>
          。请确认该目录仍可访问，或恢复后重新选择笔记目录。
        </p>
        <button class="secondary-button small" type="button" :disabled="data.busy" @click="data.prepareRestore">使用这份备份…</button>
      </div>
      <div v-if="data.rollbackPath" class="backup-preview">
        <p>恢复已准备好，重新启动后生效。请保存其他编辑中的内容，恢复期间不要手动修改数据目录。</p>
        <p class="data-detail">
          恢复前的数据将保留在：
          <code>{{ data.rollbackPath }}</code>
        </p>
        <button class="primary-button small" type="button" :disabled="data.busy" @click="data.restart">重新启动并恢复</button>
      </div>
    </div>
  </div>
  <h3 class="settings-section-title">故障反馈</h3>
  <div class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>诊断信息与本地日志</strong>
        <small>诊断信息只含版本、平台和 CLI 配置名称，不含源码、认证信息或日志正文。分享日志前请检查其中的私人内容。</small>
      </div>
      <div class="data-actions">
        <button class="secondary-button small" type="button" :disabled="data.busy" @click="data.copyDiagnostics">复制诊断信息</button>
        <button class="secondary-button small" type="button" :disabled="data.busy" @click="data.revealLogs">打开日志目录</button>
      </div>
      <textarea v-if="data.diagnostics" class="data-diagnostics" aria-label="可复制的诊断信息" readonly :value="data.diagnostics"></textarea>
    </div>
  </div>
  <p v-if="data.error" class="data-error" role="alert">{{ data.error }}</p>
  <p v-if="data.status" class="data-detail" role="status">{{ data.status }}</p>
  <h3 class="settings-section-title danger">危险操作</h3>
  <div class="settings-card glass danger-zone">
    <div class="setting-row">
      <div class="setting-label">
        <strong>重置工作包进度</strong>
        <small id="resetSummary">{{ resetSummary }}</small>
      </div>
      <div class="setting-control end">
        <button id="resetProgress" class="secondary-button danger" type="button" :disabled="resetDisabled" @click="onReset">
          <AppIcon name="trash" />
          重置…
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.data-detail {
  color: var(--text-muted);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.data-error {
  color: var(--danger);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.backup-preview {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-3);
}
.backup-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  margin: 0;
}
.backup-facts dt {
  color: var(--text-muted);
}
.backup-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.data-diagnostics {
  box-sizing: border-box;
  width: 100%;
  min-height: 220px;
  resize: vertical;
  padding: var(--space-3);
  color: var(--text);
  background: var(--fill);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  font: inherit;
  line-height: 1.6;
}
.data-diagnostics:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';

const settings = useSettingsStore();

const info = computed(() => settings.environment);
const versionFacts = computed(() =>
  info.value
    ? [
        { term: 'TaskPilot', value: info.value.versions.app },
        { term: 'Electron', value: info.value.versions.electron },
        { term: '应用内置 Node.js', value: info.value.versions.node },
        { term: '平台', value: info.value.platform },
        { term: '登录 shell', value: info.value.shell },
      ]
    : [],
);

// Previewing a source re-reads the PATH before anything is saved.
const onSourceChange = () => {
  settings.renderEnvironment().catch((error) => console.error(error));
};
const onRefresh = () => {
  settings.renderEnvironment({ refresh: true }).catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>运行环境</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      仅本设备
    </span>
  </header>
  <h3 class="settings-section-title">工具发现</h3>
  <div v-if="settings.preferencesDraft" class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>CLI 与检查命令的查找方式</strong>
        <small>自动检测本机常见安装位置，找到 CLI 及其依赖的 Node.js。无需修改你的 shell 配置；保存后用于下一次运行。</small>
      </div>
      <div class="choice-list" role="radiogroup" aria-label="PATH 来源">
        <label class="choice">
          <input
            id="environmentPathSource"
            v-model="settings.preferencesDraft.environment.pathSource"
            type="radio"
            name="pathSource"
            value="auto"
            @change="onSourceChange"
          />
          <span>
            <strong>自动检测（推荐）</strong>
            <small>保留启动环境的优先级，补充 Homebrew、原生 CLI 和 Node 版本管理器的安装目录，不启动登录 shell。</small>
          </span>
        </label>
        <label class="choice">
          <input v-model="settings.preferencesDraft.environment.pathSource" type="radio" name="pathSource" value="inherit" @change="onSourceChange" />
          <span>
            <strong>继承应用启动时的 PATH</strong>
            <small id="inheritSummary">{{ info ? `${info.inheritedCount} 个目录。从终端启动时与终端一致。` : '从终端启动时与终端一致' }}</small>
          </span>
        </label>
        <label class="choice">
          <input v-model="settings.preferencesDraft.environment.pathSource" type="radio" name="pathSource" value="login-shell" @change="onSourceChange" />
          <span>
            <strong>从登录 shell 读取</strong>
            <small id="shellSummary">
              {{
                info
                  ? info.shell
                    ? `读取 ${info.shell} 的 PATH；超时时仍使用本机自动检测结果`
                    : '未检测到登录 shell，仍可使用自动检测'
                  : '读取你的 shell 配置，超时时保留自动发现的工具'
              }}
            </small>
          </span>
        </label>
      </div>
    </div>
    <div class="setting-row stacked">
      <div class="path-header">
        <div class="setting-label">
          <strong>当前生效的 PATH</strong>
          <small id="pathSourceNote" :class="{ 'warn-text': settings.pathNote.warn }">{{ settings.pathNote.text }}</small>
        </div>
        <button id="refreshPath" class="secondary-button small" type="button" @click="onRefresh">
          <AppIcon name="refresh" />
          重新读取
        </button>
      </div>
      <details>
        <summary>查看命令查找目录（PATH）</summary>
        <ol id="pathList" class="path-list">
          <li v-if="settings.environmentLoading">读取中…</li>
          <li v-else-if="settings.environmentError" role="alert">{{ settings.environmentError }}</li>
          <template v-else-if="info">
            <li v-for="(entry, index) in info.entries" :key="index" :class="{ added: !settings.inheritedEntries.has(entry) }">{{ entry }}</li>
          </template>
        </ol>
      </details>
      <p v-if="settings.environmentError" role="alert" class="warn-text">{{ settings.environmentError }}</p>
    </div>
  </div>
  <h3 class="settings-section-title">本机 CLI 与运行时</h3>
  <div v-if="info?.tools" class="settings-card glass">
    <p class="runtime-help">
      只需准备你选用的 CLI，不必全部安装。以下是当前草稿配置的查找结果；登录、能力及编码沙箱状态在「模型与智能体」检查。Node.js
      一行指本机命令，不是应用内置版本。
    </p>
    <ul class="runtime-tools">
      <li v-for="tool in info.tools" :key="tool.id" class="runtime-tool">
        <div class="runtime-tool-copy">
          <strong>{{ tool.label }}</strong>
          <code v-if="tool.path">{{ tool.path }}</code>
          <span v-if="tool.realPath && tool.realPath !== tool.path" class="runtime-real-path">实际文件：{{ tool.realPath }}</span>
          <span v-if="tool.problem" class="warn-text">{{ tool.problem }}</span>
          <span v-else>{{ tool.requiresNode ? '已找到入口和本机 Node.js' : '已找到可执行文件' }}</span>
        </div>
        <button
          class="secondary-button small"
          type="button"
          :disabled="settings.selectingRuntime || settings.saving"
          @click="settings.selectRuntimeExecutable(tool.id)"
        >
          选择文件…
        </button>
      </li>
    </ul>
  </div>
  <h3 class="settings-section-title">补充命令目录</h3>
  <div v-if="settings.preferencesDraft" class="settings-card glass">
    <div class="setting-row stacked">
      <label class="setting-label" for="extraCommandPaths">
        <strong>自定义安装位置</strong>
        <small>
          选择上面的可执行文件会自动添加其所在目录。也可每行填一个绝对目录；排在前面的目录优先。CLI 与 node 分开安装时，请分别添加。不要填命令参数。
        </small>
      </label>
      <textarea
        id="extraCommandPaths"
        v-model="settings.extraPathText"
        class="runtime-path-input"
        rows="3"
        placeholder="/Users/你的用户名/.local/bin"
        spellcheck="false"
        @change="onSourceChange"
      ></textarea>
      <p class="runtime-help">这些目录仅保存在本机。独立账号编码模式仍需在 taskpilot-coder 账号内安装工具，不使用主账号配置。</p>
      <p v-if="settings.runtimeActionError" class="warn-text" role="alert">{{ settings.runtimeActionError }}</p>
    </div>
  </div>
  <h3 class="settings-section-title">版本</h3>
  <div class="settings-card glass">
    <dl id="versionFacts" class="fact-list">
      <template v-for="fact in versionFacts" :key="fact.term">
        <dt>{{ fact.term }}</dt>
        <dd>{{ fact.value ?? '—' }}</dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
.runtime-help {
  margin: var(--space-3) var(--space-4);
  color: var(--text-muted);
  line-height: 1.6;
}
.runtime-tools {
  margin: 0;
  padding: 0;
  list-style: none;
}
.runtime-tool {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
}
.runtime-tool + .runtime-tool {
  border-top: 1px solid var(--line-soft);
}
.runtime-tool-copy {
  display: grid;
  min-width: 0;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
.runtime-tool-copy code {
  white-space: normal;
}
.runtime-tool-copy span {
  font-size: var(--text-sm);
}
.runtime-real-path {
  color: var(--text-muted);
}
.runtime-tool button {
  flex-shrink: 0;
}
.runtime-path-input {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  padding: var(--space-3);
  color: var(--text);
  background: var(--fill);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  font: inherit;
  line-height: 1.6;
}
.runtime-path-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>

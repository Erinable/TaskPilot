<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import { describeError } from '@/lib/errors.ts';
import { useSettingsStore } from '@/stores/settings.ts';

// How the Coding Agent is kept away from the rest of the computer, and the
// folders let into the sandbox. Edits the settings draft; the page saves it.
const settings = useSettingsStore();
const coding = computed(() => settings.preferencesDraft?.coding ?? null);

const TIMEOUTS = [15, 30, 60, 120] as const;

const MODES = [
  {
    value: 'sandbox',
    title: '沙箱（推荐）',
    body: '用你自己的账号运行，但 TaskPilot 用 macOS 沙箱把它关在一份项目副本里：只能读写这份副本，读不到你主目录里的其他文件。开箱即用，不用额外设置。可以联网。',
  },
  {
    value: 'separate-user',
    title: '独立账号（更严）',
    body: '在单独的系统账号 taskpilot-coder 里运行，连它自己的登录凭据也和你的分开。需要先在终端里运行一次初始化脚本（要输入电脑密码）。',
  },
] as const;

// Folders that hold keys, tokens or personal files; adding one asks twice.
const SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.netrc', 'Library'];
const sensitive = (folder: string) => SENSITIVE.some((name) => folder.includes(`/${name}`) && new RegExp(`/${name.replace('.', '\\.')}(/|$)`).test(folder));

const add = async (list: 'extraRead' | 'extraWrite') => {
  if (!coding.value) return;
  let folder: string | null;
  try {
    folder = await settings.pickFolder();
  } catch (error) {
    showToast(`选择文件夹失败：${describeError(error)}`);
    return;
  }
  if (!folder || coding.value[list].includes(folder)) return;
  if (sensitive(folder)) {
    const proceed = await confirmAction({
      title: '这个文件夹可能存着密钥或个人文件',
      body: `「${folder}」通常保存登录凭据、密钥或个人文件。放进沙箱后，Coding Agent ${list === 'extraWrite' ? '能读也能改' : '能读到'}里面的内容，并且可以联网发出去。确定要添加吗？`,
      accept: '仍然添加',
      danger: true,
    });
    if (!proceed) return;
  }
  coding.value[list] = [...coding.value[list], folder];
};
const remove = (list: 'extraRead' | 'extraWrite', folder: string) => {
  if (coding.value) coding.value[list] = coding.value[list].filter((entry) => entry !== folder);
};
</script>

<template>
  <section v-if="coding" class="settings-group coding-isolation" aria-labelledby="codingIsolationTitle">
    <h3 id="codingIsolationTitle">编码隔离</h3>
    <p class="hint">Coding Agent 会改代码、执行命令。这里决定怎么把它和你电脑上的其他东西隔开。</p>

    <div class="isolation-modes" role="radiogroup" aria-labelledby="codingIsolationTitle">
      <label v-for="mode in MODES" :key="mode.value" class="isolation-mode" :class="{ active: coding.isolation === mode.value }">
        <input v-model="coding.isolation" type="radio" name="coding-isolation" :value="mode.value" />
        <span>
          <strong>{{ mode.title }}</strong>
          <small>{{ mode.body }}</small>
        </span>
      </label>
    </div>

    <label class="coding-timeout">
      <span>
        <strong>每轮时间上限</strong>
        <small class="hint">到时间 AI 会被停下，已经写好的部分留给你检查，不会自动应用。</small>
      </span>
      <el-select v-model="coding.timeoutMinutes" aria-label="每轮时间上限" class="coding-timeout-select">
        <el-option v-for="minutes in TIMEOUTS" :key="minutes" :label="`${minutes} 分钟`" :value="minutes" />
      </el-select>
    </label>

    <template v-if="coding.isolation === 'sandbox'">
      <div class="sandbox-defaults">
        <strong>默认权限</strong>
        <ul>
          <li>读写：这份项目副本、临时文件夹</li>
          <li>
            读写：这次运行专用的主目录。所选 CLI 的登录凭据会复制进去，所以 AI 能读到它；你真正的 ~/.claude 等配置目录它改不了，运行后只写回更新过的登录凭据
          </li>
          <li>只读：你主目录以外的系统文件，以及 PATH 上的开发工具（例如 ~/.nvm）</li>
          <li>不能读：主目录里的其他文件，例如 ~/.ssh、~/.aws、你的其他项目。文件名和大小仍然看得到</li>
          <li>可以联网：CLI 要连模型服务，沙箱分不清哪些请求是它自己发的</li>
        </ul>
      </div>

      <div v-for="list in ['extraRead', 'extraWrite'] as const" :key="list" class="sandbox-exceptions">
        <div class="sandbox-exceptions-head">
          <strong>{{ list === 'extraRead' ? '额外可读的文件夹' : '额外可读写的文件夹' }}</strong>
          <button class="secondary-button small" type="button" @click="add(list)">
            <AppIcon name="plus" />
            添加文件夹
          </button>
        </div>
        <p class="hint">{{ list === 'extraRead' ? '例如同一个大项目里的另一个仓库。' : '例如项目外的构建输出目录。只在确实需要时添加。' }}</p>
        <ul v-if="coding[list].length" class="sandbox-folders">
          <li v-for="folder in coding[list]" :key="folder" :class="{ sensitive: sensitive(folder) }">
            <AppIcon :name="sensitive(folder) ? 'alert' : 'folder'" />
            <code>{{ folder }}</code>
            <button class="icon-button small" type="button" :aria-label="`移除 ${folder}`" title="移除" @click="remove(list, folder)">
              <AppIcon name="x" />
            </button>
          </li>
        </ul>
        <p v-else class="sandbox-none">没有</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* Lines up with the agent row above it (16px side padding) and is set off
   from it, so it reads as part of the coding group, not loose text. */
.coding-isolation {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) 16px var(--space-4);
  border-top: 1px solid var(--line-soft);
}
.coding-isolation h3 {
  margin: 0;
  font-size: var(--text-md);
}
.hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.isolation-modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}
.isolation-mode {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  padding: var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.isolation-mode.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.isolation-mode input {
  margin-top: 3px;
}
.isolation-mode span {
  display: grid;
  gap: var(--space-1);
}
.isolation-mode small {
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.6;
}
.coding-timeout {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-sm);
}
.coding-timeout span {
  display: grid;
  gap: var(--space-1);
}
.coding-timeout-select {
  width: 140px;
  flex: none;
}
.sandbox-defaults {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--fill);
  font-size: var(--text-sm);
}
.sandbox-defaults ul {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding-left: 1.2em;
  color: var(--text-secondary);
  line-height: 1.6;
}
.sandbox-exceptions {
  display: grid;
  gap: var(--space-1);
}
.sandbox-exceptions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-sm);
}
.sandbox-folders {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.sandbox-folders li {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--fill);
  font-size: var(--text-sm);
}
.sandbox-folders li.sensitive {
  color: var(--warning);
}
.sandbox-folders .icon {
  width: 14px;
  height: 14px;
  flex: none;
}
.sandbox-folders code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sandbox-none {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
@media (max-width: 900px) {
  .isolation-modes {
    grid-template-columns: 1fr;
  }
}
</style>

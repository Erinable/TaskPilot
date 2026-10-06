<script setup lang="ts">
// The new requirement form.
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { ERROR_HINTS } from '@/lib/errors.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { MAX_TEXT, countChars } from './requirement_model.ts';

const store = useRequirementsStore();
const textInput = ref<{ focus: () => void } | null>(null);

const count = computed(() => countChars(store.composeText));

const workspaceFact = computed(() => {
  const workspace = store.composeContext?.workspace;
  if (!workspace) return null;
  return workspace.configured
    ? `Architect 会读取仓库 ${workspace.root.split(/[\\/]/).filter(Boolean).pop()} 中与需求相关的少量已提交文件（最多 12 个），整理成接口摘要；可能含密钥的文件、未跟踪文件和二进制文件不会读取。Product Lead 只看摘要和路径列表。`
    : '还没有配置仓库，Product Lead 会按常见目录结构推测文件路径。';
});

const focusText = () => { nextTick(() => textInput.value?.focus()).catch((error) => console.error(error)); };

onMounted(focusText);
watch(() => store.composeFocus, focusText);

// ⌘↩ submits the requirement from the textarea.
const onKeydown = (event: Event | KeyboardEvent) => {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) store.submitNew().catch((error) => console.error(error));
};

const onSubmit = () => { store.submitNew().catch((error) => console.error(error)); };
</script>

<template>
  <form class="req-pane" data-pane="new" novalidate @submit.prevent="onSubmit">
    <header class="req-header">
      <div class="agent-chip"><span class="agent-avatar pm">PM</span><span>Product Lead</span></div>
      <h2>描述你的需求</h2>
      <p>写下要做什么、为什么做。Product Lead 会先提出澄清问题，再把需求拆成可执行的工作包，你确认后才会进入工作队列。</p>
    </header>
    <div class="settings-card glass req-form-card">
      <div class="setting-row stacked">
        <label class="setting-label" for="reqTitle"><strong>标题（可选）</strong><small>留空时 Product Lead 会起一个</small></label>
        <el-input id="reqTitle" v-model="store.composeTitle" maxlength="60" autocomplete="off" placeholder="例如：邮箱登录" />
      </div>
      <div class="setting-row stacked">
        <label class="setting-label" for="reqText"><strong>需求描述</strong></label>
        <el-input
          id="reqText"
          ref="textInput"
          v-model="store.composeText"
          class="req-textarea"
          type="textarea"
          :rows="8"
          placeholder="例如：用户可以用邮箱和密码登录。登录失败时不能暴露邮箱是否注册。需要为现有的 UserRepository 补测试。"
          aria-describedby="reqTextStatus"
          :aria-invalid="String(store.composeInvalid)"
          @input="store.onComposeInput"
          @keydown="onKeydown"
        />
        <div class="field-meta">
          <p id="reqTextStatus" class="field-status" :class="{ error: store.composeStatus.error }" aria-live="polite">{{ store.composeStatus.text }}</p>
          <span class="char-count" :class="{ over: count > MAX_TEXT }">{{ `${count}/${MAX_TEXT}` }}</span>
        </div>
      </div>
    </div>
    <div class="req-context">
      <template v-if="store.composeContext">
        <ul class="req-context-list">
          <li><AppIcon :name="store.composeContext.workspace.configured ? 'git-branch' : 'info'" />{{ workspaceFact }}</li>
          <li><AppIcon name="terminal" />通过本机的 Claude Code CLI 运行，不启用任何工具，单次费用上限 1 美元。</li>
        </ul>
        <p v-if="!store.composeContext.agentAvailable" class="req-warning"><AppIcon name="alert" />{{ ERROR_HINTS.agent_unavailable }}</p>
      </template>
    </div>
    <div class="req-actions">
      <button class="primary-button" type="submit" :disabled="store.submitting"><AppIcon name="send" />交给 Product Lead</button>
    </div>
  </form>
</template>

<style scoped>
.req-textarea :deep(textarea) { min-height: 160px; line-height: 1.6; }
.req-textarea :deep(textarea[aria-invalid="true"]) { box-shadow: 0 0 0 1px var(--danger) inset, 0 0 0 3px var(--danger-soft); }
</style>

<script setup lang="ts">
// The new requirement form: "我想做…" for work on the repository, or
// "我想学…" for a course, where the learner also picks their level, target,
// environment and weekly time before Tutor's interview.
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import DraftNotice from '@/components/DraftNotice.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { LAB_TOOLCHAINS, TOOLCHAIN_LABELS } from '@shared/lab_toolchains.ts';
import { HOURS_OPTIONS, LEVEL_OPTIONS, MAX_TEXT, TARGET_OPTIONS, countChars } from './requirement_model.ts';

const store = useRequirementsStore();
const textInput = ref<{ focus: () => void } | null>(null);

const count = computed(() => countChars(store.composeText));
const course = computed(() => store.composeKind === 'course');
const draftBlocked = computed(() => store.composeDraftState.pending || store.composeDraftState.conflict);
const needsRuntime = computed(() => !course.value && store.composeContext?.agentAvailable === false);
const runtimeBlocked = computed(() => !course.value && (store.composeContextLoading || Boolean(store.composeContextError) || needsRuntime.value));
const configureRuntime = () =>
  useSettingsStore()
    .open('environment')
    .catch((error) => console.error(error));

const workspaceFact = computed(() => {
  const workspace = store.composeContext?.workspace;
  if (!workspace) return null;
  return workspace.configured
    ? `Architect 会读取仓库 ${workspace.root.split(/[\\/]/).filter(Boolean).pop()} 中与需求相关的少量已提交文件（最多 12 个），整理成接口摘要；可能含密钥的文件、未跟踪文件和二进制文件不会读取。Product Lead 只看摘要和路径列表。`
    : '还没有配置仓库，Product Lead 会按常见目录结构推测文件路径。';
});

const focusText = () => {
  nextTick(() => textInput.value?.focus()).catch((error) => console.error(error));
};

onMounted(focusText);
watch(() => store.composeFocus, focusText);

// ⌘↩ submits the requirement from the textarea.
const onKeydown = (event: Event | KeyboardEvent) => {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault();
  onSubmit();
};

const onSubmit = () => {
  if (store.submitting || draftBlocked.value || runtimeBlocked.value || (course.value && !store.composeForm.toolchain)) return;
  store.submitNew().catch((error) => console.error(error));
};
</script>

<template>
  <form class="req-pane" data-pane="new" novalidate @submit.prevent="onSubmit">
    <DraftNotice :state="store.composeDraftState" :busy="store.submitting" @restore="store.restoreComposeDraft" @discard="store.discardComposeDraft" />
    <div class="req-kind-switch" :inert="draftBlocked">
      <el-radio-group v-model="store.composeKind" size="small" aria-label="想做什么">
        <el-radio-button value="project" data-kind="project">我想做…</el-radio-button>
        <el-radio-button value="course" data-kind="course">我想学…</el-radio-button>
      </el-radio-group>
    </div>
    <header v-if="course" class="req-header">
      <div class="agent-chip">
        <span class="agent-avatar tutor">TU</span>
        <span>Tutor</span>
      </div>
      <h2>你想学什么</h2>
      <p>
        写下想学的内容，再点选你的基础和时间。Tutor 会挑一个合适的课程包，最多再问 3 个问题，然后从课程包的知识点里排出你的学习路径；没有合适的课程包时，可以让
        Tutor 起草一个。
      </p>
    </header>
    <header v-else class="req-header">
      <div class="agent-chip">
        <span class="agent-avatar pm">PM</span>
        <span>Product Lead</span>
      </div>
      <h2>描述你的需求</h2>
      <p>写下要做什么、为什么做。Product Lead 会先提出澄清问题，再把需求拆成可执行的工作包，你确认后才会进入工作队列。</p>
    </header>
    <div class="settings-card glass req-form-card" :inert="draftBlocked">
      <div v-if="!course" class="setting-row stacked">
        <label class="setting-label" for="reqTitle">
          <strong>标题（可选）</strong>
          <small>留空时 Product Lead 会起一个</small>
        </label>
        <el-input id="reqTitle" v-model="store.composeTitle" maxlength="60" autocomplete="off" placeholder="例如：邮箱登录" />
      </div>
      <div class="setting-row stacked">
        <label class="setting-label" for="reqText">
          <strong>{{ course ? '想学的内容' : '需求描述' }}</strong>
        </label>
        <el-input
          id="reqText"
          ref="textInput"
          v-model="store.composeText"
          class="req-textarea"
          type="textarea"
          :rows="8"
          :placeholder="
            course ? '例如：想学操作系统的进程调度。' : '例如：用户可以用邮箱和密码登录。登录失败时不能暴露邮箱是否注册。需要为现有的 UserRepository 补测试。'
          "
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
      <template v-if="course">
        <div class="setting-row stacked" data-field="level">
          <span class="setting-label"><strong>基础</strong></span>
          <el-radio-group v-model="store.composeForm.level" aria-label="基础">
            <el-radio-button v-for="option in LEVEL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="setting-row stacked" data-field="target">
          <span class="setting-label"><strong>目标</strong></span>
          <el-radio-group v-model="store.composeForm.target" aria-label="目标">
            <el-radio-button v-for="option in TARGET_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="setting-row stacked" data-field="toolchain">
          <span class="setting-label">
            <strong>实验工具链</strong>
            <small>生成 lab 前会检查这些工具是否已安装</small>
          </span>
          <el-radio-group v-model="store.composeForm.toolchain" aria-label="实验工具链">
            <el-radio-button v-for="toolchain in LAB_TOOLCHAINS" :key="toolchain" :value="toolchain">{{ TOOLCHAIN_LABELS[toolchain] }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="setting-row stacked" data-field="environment">
          <label class="setting-label" for="reqEnvironment">
            <strong>环境备注（可选）</strong>
            <small>补充你的系统或已有配置，不影响工具链选择</small>
          </label>
          <el-input id="reqEnvironment" v-model="store.composeForm.environment" maxlength="100" aria-label="环境备注（可选）" />
        </div>
        <div class="setting-row stacked" data-field="weeklyHours">
          <span class="setting-label"><strong>每周时间</strong></span>
          <el-radio-group v-model="store.composeForm.weeklyHours" aria-label="每周时间">
            <el-radio-button v-for="hours in HOURS_OPTIONS" :key="hours" :value="hours">{{ `${hours} 小时` }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="setting-row stacked" data-field="title">
          <label class="setting-label" for="reqTitle">
            <strong>标题（可选）</strong>
            <small>留空时 Tutor 会起一个</small>
          </label>
          <el-input id="reqTitle" v-model="store.composeTitle" maxlength="60" autocomplete="off" placeholder="例如：操作系统进程调度" />
        </div>
      </template>
    </div>
    <div class="req-context">
      <template v-if="store.composeContext && course">
        <ul class="req-context-list">
          <li>
            <AppIcon name="blocks" />
            Tutor 只看本机能用的课程包（内置的，或已在本机确认的）的知识点列表，不读仓库代码。
          </li>
          <li>
            <AppIcon name="terminal" />
            通过本机的 CLI 运行，不启用任何工具，花费计入 AI 团队页的本周统计。
          </li>
        </ul>
      </template>
      <template v-else-if="store.composeContext">
        <ul class="req-context-list">
          <li>
            <AppIcon :name="store.composeContext.workspace.configured ? 'git-branch' : 'info'" />
            {{ workspaceFact }}
          </li>
          <li>
            <AppIcon name="terminal" />
            通过所选的本机规划 CLI 运行，不启用任何工具，花费计入 AI 团队页的本周统计。
          </li>
        </ul>
      </template>
      <div v-if="!course && (needsRuntime || store.composeContextError)" class="req-warning compose-runtime-warning" role="status">
        <AppIcon name="alert" />
        <div>
          <strong>{{ store.composeContextError ?? '需求规划所需的 CLI 还不能运行' }}</strong>
          <p>你的输入会保留。检查运行环境，或在「模型与智能体」选择已安装的 CLI，完成后回到这里重新检查。</p>
        </div>
      </div>
      <p v-else-if="!course && store.composeContextLoading" class="empty-hint" role="status">正在检查运行环境…</p>
    </div>
    <div class="req-actions">
      <template v-if="!course && (needsRuntime || store.composeContextError)">
        <button
          class="secondary-button"
          type="button"
          data-action="recheck-runtime"
          :disabled="store.composeContextLoading"
          @click="store.refreshComposeContext()"
        >
          <AppIcon name="refresh" />
          重新检查
        </button>
        <button class="primary-button" type="button" data-action="configure-runtime" @click="configureRuntime">
          <AppIcon name="settings" />
          配置运行环境
        </button>
      </template>
      <button
        v-else
        class="primary-button"
        type="submit"
        :disabled="store.submitting || draftBlocked || runtimeBlocked || (course && !store.composeForm.toolchain)"
        :aria-busy="store.submitting || (!course && store.composeContextLoading)"
      >
        <AppIcon
          :name="store.submitting || (!course && store.composeContextLoading) ? 'spinner' : 'send'"
          :class="{ spin: store.submitting || (!course && store.composeContextLoading) }"
        />
        {{ !course && store.composeContextLoading ? '正在检查运行环境…' : course ? '交给 Tutor' : '交给 Product Lead' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.req-kind-switch {
  display: flex;
  justify-content: flex-start;
}
.compose-runtime-warning {
  align-items: flex-start;
}
.compose-runtime-warning p {
  margin: var(--space-1) 0 0;
  line-height: 1.6;
}
.req-textarea :deep(textarea) {
  min-height: 160px;
  line-height: 1.6;
}
.req-textarea :deep(textarea[aria-invalid='true']) {
  box-shadow:
    0 0 0 1px var(--danger) inset,
    0 0 0 3px var(--danger-soft);
}
</style>

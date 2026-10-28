<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import CodingChecks from '@/components/execution/CodingChecks.vue';
import CodingPatchReview from '@/components/execution/CodingPatchReview.vue';
import CodingRoundHistory from '@/components/execution/CodingRoundHistory.vue';
import CodingTranscript from '@/components/execution/CodingTranscript.vue';
import { useCodingStore } from '@/stores/coding.ts';
import { elapsedSince, useNow } from '@/lib/elapsed.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import { CODING_SETUP_TEXT, codingSetupIssue } from '@shared/coding_setup.ts';
import type * as codingTypes from '@shared/coding_types.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

const props = defineProps<{ task: packageTypes.TaskView }>();
const coding = useCodingStore();
const highRiskConsent = ref(false);
const now = useNow();

const STATUS_LABELS: Record<codingTypes.CodingRun['status'], string> = {
  preparing: '准备中',
  running: '编码中',
  checking: '检查中',
  ready: '待人工应用',
  applying: '应用中',
  verifying: '提交前检查中',
  applied: '已应用',
  submitted: '已提交审查',
  failed: '失败',
  cancelled: '已取消',
  discarded: '已丢弃',
};
const HALT_TEXT: Record<codingTypes.CodingHalt, string> = {
  attempts_exhausted: '已自动重试 3 轮仍未通过，交给你处理：可以自己修改，或补充说明后重新开始。',
  high_risk: '这一轮改到了高风险文件（项目配置、脚本或测试），自动流程停在这里，请检查后再决定是否应用。',
  no_changes: '这一轮 AI 没有产生可以应用的改动，自动流程已停止。',
  stopped: '自动流程已停止。',
  conflict: '这一轮的改动和你在这段时间里改的内容撞在了同一处，自动流程停下了，没有覆盖你的改动。请在下面为冲突的文件选怎么处理。',
  markers: '有文件写入了冲突标记（<<<<<<< 你的改动 / >>>>>>> Coding Agent 那几行）。在编辑器里保留想要的内容、删掉标记并保存，再点「冲突已解决，继续」。',
  timed_out:
    '这一轮超过了时间上限，AI 被停下了。下面是它停下前写好的部分，可能没写完，请逐个文件检查后再决定是否应用；也可以到「设置 → 模型与智能体 → 编码隔离」调长上限。',
};
// Rounds the loop can restart from: a finished chain or a stopped one.
const RESTARTABLE: codingTypes.CodingRun['status'][] = ['failed', 'cancelled', 'discarded', 'applied', 'submitted'];

const runError = computed(() => coding.run?.error);
// The plain explanation, with the CLI's own message folded below when it adds something.
const runErrorText = computed(() => describeErrorInfo(runError.value));
const runErrorDetail = computed(() => (runError.value?.message && runError.value.message !== runErrorText.value ? runError.value.message : null));
const elapsed = computed(() => (coding.active || coding.loopActive ? elapsedSince(coding.run?.startedAt, now.value) : null));
// Why the runtime is unavailable, in plain words; the raw reason sits folded below.
const setup = computed(() => (coding.runtime && !coding.runtime.available ? CODING_SETUP_TEXT[codingSetupIssue(coding.runtime.reason)] : null));
const restartable = computed(() => !!coding.run && RESTARTABLE.includes(coding.run.status) && !coding.loopActive);
const applyDisabled = computed(
  () =>
    !coding.patch || !coding.selectedFiles.length || (coding.highRisk && !highRiskConsent.value) || coding.unresolved.length > 0 || coding.operation !== null,
);
const toggle = (filePath: string, accepted: boolean) => coding.toggleFile(filePath, accepted);
const cost = computed(() =>
  coding.run?.usage.costUsd === null || coding.run?.usage.costUsd === undefined ? '未知' : `$${coding.run.usage.costUsd.toFixed(4)}`,
);
const tokenText = computed(() => {
  const usage = coding.run?.usage;
  if (!usage) return '未知';
  const input = usage.inputTokens === null ? '未知' : usage.inputTokens;
  const output = usage.outputTokens === null ? '未知' : usage.outputTokens;
  return `${input} 输入 / ${output} 输出`;
});

const checks = computed(() =>
  Object.entries(coding.run?.checks ?? {}).flatMap(([kind, check]) => (check ? [{ kind: kind as workspaceTypes.CheckKind, check }] : [])),
);
const select = (id: string) => {
  highRiskConsent.value = false;
  coding.select(id).catch((error) => console.error(error));
};
watch(() => props.task.id, select, { immediate: true });
onBeforeUnmount(() => coding.leave());
const start = () => coding.start().catch((error) => console.error(error));
const retry = () => coding.start(coding.instruction, true).catch((error) => console.error(error));
const cancel = () => coding.cancel().catch((error) => console.error(error));
const apply = () => coding.apply(coding.highRisk && highRiskConsent.value).catch((error) => console.error(error));
const resume = () => coding.resume().catch((error) => console.error(error));
</script>

<template>
  <section class="panel glass coding-panel" aria-labelledby="codingTitle">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="terminal" /></span>
        <div>
          <h2 id="codingTitle">Coding Agent</h2>
          <p>{{ coding.runtime?.boundary === 'separate-user' ? '独立账号执行' : '沙箱内执行' }}；分析、审查和提交仍由人完成</p>
        </div>
      </div>
      <span v-if="coding.run" class="coding-status" :class="coding.run.status">{{ STATUS_LABELS[coding.run.status] }}</span>
    </div>

    <div v-if="coding.runtime && !coding.runtime.available && setup" class="coding-offline" role="status">
      <AppIcon name="alert" />
      <div class="coding-setup">
        <strong>{{ setup.title }}</strong>
        <p>{{ setup.body }}</p>
        <template v-if="setup.runSetup && coding.runtime.boundary === 'separate-user'">
          <p>在「终端」里依次运行下面两条命令。第一条只显示它会做什么，不改任何东西；看过没问题再运行第二条，需要输入电脑密码。TaskPilot 不会替你运行。</p>
          <code class="coding-command">{{ coding.setupScript }}</code>
          <code class="coding-command">{{ coding.setupScript }} --apply</code>
          <p>完成后，还要在这个账号里安装并登录所选的 CLI，脚本最后会告诉你怎么做。</p>
        </template>
        <div class="coding-setup-actions">
          <button class="secondary-button small" type="button" :disabled="coding.runtimeLoading" @click="coding.refreshRuntime()">
            <AppIcon :name="coding.runtimeLoading ? 'spinner' : 'refresh'" :class="{ spin: coding.runtimeLoading }" />
            设置好了，重新检查
          </button>
        </div>
        <details v-if="coding.runtime.reason" class="coding-raw">
          <summary>系统原始信息</summary>
          <pre>{{ coding.runtime.reason }}</pre>
        </details>
      </div>
    </div>
    <p v-else-if="coding.runtimeLoading" class="empty-hint">
      <AppIcon name="spinner" class="spin" />
      正在刷新运行时状态…
    </p>
    <p v-else-if="coding.runtimeError" class="coding-error">
      <AppIcon name="alert" />
      {{ coding.runtimeError }}
    </p>
    <details v-if="coding.runtime && !coding.run" class="coding-details">
      <summary>运行配置</summary>
      <div class="coding-meta" aria-label="当前编码运行时">
        <span>CLI：{{ coding.runtime.backend }}</span>
        <span>模型：{{ coding.runtime.config.model || 'CLI 默认模型' }}</span>
        <span>
          <TermHint term="thinking" />
          ：{{ coding.runtime.config.thinking }}
        </span>
        <span>每轮最长 {{ coding.runtime.config.timeoutMinutes }} 分钟</span>
      </div>
    </details>

    <CodingRoundHistory
      v-if="coding.run && (coding.run.rounds.length || coding.run.attempt > 1)"
      :run="coding.run"
      :status-labels="STATUS_LABELS"
      :max-auto-attempts="coding.maxAutoAttempts"
    />
    <p v-if="coding.run?.halt" class="coding-halt" role="status">
      <AppIcon name="info" />
      {{ HALT_TEXT[coding.run.halt] }}
    </p>

    <div v-if="!coding.run || restartable" class="coding-start">
      <label for="codingInstruction">给 Coding Agent 的说明</label>
      <textarea
        id="codingInstruction"
        v-model="coding.instruction"
        rows="4"
        maxlength="12000"
        placeholder="工作包的步骤、文件范围和验收条件会自动带上。这里写你想额外强调的。"
        :disabled="!coding.runtime?.available || coding.operation !== null"
      ></textarea>
      <p class="coding-hint">
        AI 在项目副本里写，写好后由你逐个文件确认。之后自动检查、交给 QA，没通过会自动交回 AI 重试，最多 {{ coding.maxAutoAttempts }} 轮。不会提交或推送。
      </p>
      <div v-if="runError" class="coding-error">
        <AppIcon name="alert" />
        <span>{{ runErrorText }}</span>
        <details v-if="runErrorDetail" class="coding-raw">
          <summary>原始信息</summary>
          <pre>{{ runErrorDetail }}</pre>
        </details>
      </div>
      <div class="coding-actions">
        <button v-if="coding.run" class="secondary-button" type="button" :disabled="!coding.canStart" @click="retry">
          <AppIcon name="refresh" />
          重新开始编码
        </button>
        <button v-else class="primary-button" type="button" :disabled="!coding.canStart" @click="start">
          <AppIcon name="play" />
          开始编码
        </button>
      </div>
    </div>

    <template v-if="coding.run">
      <div class="coding-summary" role="status">
        <span v-if="elapsed">已用 {{ elapsed }}</span>
        <span>费用 {{ cost }}</span>
        <details class="coding-details">
          <summary>运行详情</summary>
          <div class="coding-meta">
            <span>账号：{{ coding.run.user }}</span>
            <span>CLI：{{ coding.run.cli }}</span>
            <span>模型：{{ coding.run.model || 'CLI 默认模型' }}</span>
            <span>
              <TermHint term="thinking" />
              ：{{ coding.run.thinking }}
            </span>
            <span>Token：{{ tokenText }}</span>
          </div>
        </details>
      </div>
      <div class="coding-actions">
        <button
          v-if="coding.active || coding.run.status === 'ready'"
          class="secondary-button danger"
          type="button"
          :disabled="coding.operation !== null"
          @click="cancel"
        >
          <AppIcon name="ban" />
          {{
            coding.run.status === 'ready' ? '取消并丢弃结果' : coding.run.status === 'verifying' || coding.run.trigger !== 'human' ? '停止自动重试' : '取消编码'
          }}
        </button>
      </div>

      <p v-if="coding.active && coding.run.status !== 'verifying'" class="coding-hint coding-scope-hint">
        AI 写代码时，尽量别改这个工作包范围内的文件（{{ task.fileScope.slice(0, 3).join('、') }}{{ task.fileScope.length > 3 ? ' 等' : '' }}）。
        改了也没关系：应用时会先合并，撞在同一处才需要你来选。
      </p>
      <CodingTranscript :events="coding.events" />

      <CodingPatchReview
        v-if="coding.run.status === 'ready' && (coding.run.trigger === 'human' || coding.run.halt)"
        :patch="coding.patch"
        :patch-loading="coding.patchLoading"
        :selected-files="coding.selectedFiles"
        :resolutions="coding.resolutions"
        :high-risk="coding.highRisk"
        :high-risk-consent="highRiskConsent"
        :operation="coding.operation"
        :unresolved="coding.unresolved"
        :apply-disabled="applyDisabled"
        :applicable="coding.applicable"
        :merge-of="coding.mergeOf"
        @toggle-file="toggle"
        @set-resolution="coding.setResolution"
        @update-high-risk-consent="highRiskConsent = $event"
        @apply="apply"
      />
      <div v-if="coding.run.status === 'ready' && coding.run.trigger !== 'human' && !coding.run.halt" class="empty-hint">
        <AppIcon name="spinner" class="spin" />
        正在自动应用这一轮的补丁…
      </div>
      <div v-if="coding.run.status === 'verifying'" class="empty-hint">
        <AppIcon name="spinner" class="spin" />
        补丁已写入工作区，正在用你的账号权限跑提交前检查…
      </div>
      <div v-if="coding.run.status === 'applied' && coding.run.halt === 'markers'" class="coding-applied" role="alert">
        <AppIcon name="alert" />
        <div>
          <p>这些文件里可能有冲突标记，改完再继续：</p>
          <ul>
            <li v-for="file in coding.run.files" :key="file.path">
              <code>{{ file.path }}</code>
            </li>
          </ul>
          <button class="primary-button small" type="button" :disabled="coding.operation !== null" @click="resume">
            <AppIcon name="check" />
            冲突已解决，继续
          </button>
        </div>
      </div>
      <div v-else-if="coding.run.status === 'applied'" class="coding-applied" role="alert">
        <AppIcon name="alert" />
        改动已写入工作区，自动流程停在这里。你可以自己修改后提交审查，或补充说明后重新开始编码。
      </div>
      <div v-if="coding.run.status === 'submitted'" class="coding-applied" role="status">
        <AppIcon name="send" />
        检查通过，Coding Agent 已提交 QA 审查。
      </div>
      <CodingChecks :checks="checks" />
    </template>
    <p v-if="coding.error" class="coding-error">
      <AppIcon name="alert" />
      {{ coding.error }}
    </p>
  </section>
</template>

<style scoped>
.coding-panel {
  display: grid;
  gap: 14px;
}
.coding-status {
  color: var(--accent);
  font-size: var(--text-xs);
  font-weight: 700;
}
.coding-status.failed,
.coding-error,
.coding-status.cancelled {
  color: var(--danger);
}
.coding-status.ready {
  color: var(--warning);
}
.coding-offline,
.coding-applied {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
}
.coding-setup {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}
.coding-setup p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.coding-command {
  display: block;
  padding: var(--space-2) var(--space-3);
  overflow-x: auto;
  border-radius: var(--radius-sm);
  background: var(--fill);
  font: var(--text-sm) var(--font-mono);
  white-space: nowrap;
  user-select: all;
}
.coding-raw {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.coding-raw pre {
  margin: var(--space-1) 0 0;
  white-space: pre-wrap;
}
.coding-offline > .icon,
.coding-applied > .icon {
  flex: none;
  color: var(--warning);
}
.coding-offline p,
.coding-hint {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.coding-start {
  display: grid;
  gap: 8px;
}
.coding-start label {
  font-weight: 650;
}
.coding-start textarea {
  width: 100%;
  min-height: 100px;
  resize: vertical;
}
.coding-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.coding-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
/* Elapsed time and cost lead; the runtime details stay folded. */
.coding-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.coding-details summary {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  cursor: pointer;
}
.coding-details .coding-meta {
  margin-top: 6px;
}
.coding-summary .coding-details {
  flex-basis: 100%;
}
div.coding-error {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  font-size: var(--text-sm);
}
div.coding-error .coding-raw {
  grid-column: 2;
}
.coding-halt {
  font-size: var(--text-sm);
}
.coding-halt {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  color: var(--warning);
}
.empty-hint {
  margin: 0;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import { useCodingStore } from '@/stores/coding.ts';
import { VERIFY_LABELS } from '@/stores/execution.ts';
import { splitPatch } from '@/lib/coding_patch.ts';
import { elapsedSince, useNow } from '@/lib/elapsed.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import { diffLineKind } from '@/lib/review_model.ts';
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
// The transcript in plain words; the CLI's raw event kinds mean nothing to a beginner.
const EVENT_LABELS: Record<codingTypes.CodingEvent['type'], string> = { status: '进度', text: '说明', thinking: '思考', tool: '操作', error: '出错' };
const TRIGGER_LABELS: Record<codingTypes.CodingTrigger, string> = { human: '你发起', checks_failed: '检查失败后重试', qa_rejected: 'QA 驳回后重试' };
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
const MERGE_LABELS: Record<codingTypes.CodingMergeFile['state'], string> = { clean: '', merged: '已和你的改动合并', conflict: '和你的改动冲突' };
// The choices for one conflict; markers only where the file can carry them.
const choicesFor = (merge: codingTypes.CodingMergeFile) => [
  ...(merge.markers ? [{ value: 'markers' as const, label: '写入冲突标记，我来改' }] : []),
  { value: 'mine' as const, label: '保留我的，跳过 AI 的改动' },
  { value: 'theirs' as const, label: '用 AI 的版本覆盖' },
];
const resume = () => coding.resume().catch((error) => console.error(error));
const fileDiffs = computed(() => {
  const segments = coding.patch ? splitPatch(coding.patch.patch) : [];
  return (coding.patch?.files ?? []).map((file, index) => ({
    file,
    lines: (segments[index] ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ({ kind: diffLineKind(line), text: line })),
    applicable: coding.applicable(file),
    reasons: (coding.patch?.blocked ?? []).filter((entry) => entry.path === file.path).map((entry) => entry.reason),
  }));
});
const toggle = (filePath: string, event: Event) => coding.toggleFile(filePath, (event.target as HTMLInputElement).checked);
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

    <div v-if="coding.run && (coding.run.rounds.length || coding.run.attempt > 1)" class="coding-rounds" aria-label="编码轮次">
      <strong>第 {{ coding.run.attempt }} 轮（自动重试最多 {{ coding.maxAutoAttempts }} 轮）</strong>
      <ol>
        <li v-for="round in coding.run.rounds" :key="round.attempt">
          第 {{ round.attempt }} 轮 · {{ TRIGGER_LABELS[round.trigger] }} · {{ STATUS_LABELS[round.status] }} · {{ round.files }} 个文件
        </li>
        <li class="current">第 {{ coding.run.attempt }} 轮 · {{ TRIGGER_LABELS[coding.run.trigger] }} · {{ STATUS_LABELS[coding.run.status] }}</li>
      </ol>
      <details v-if="coding.run.feedback">
        <summary>这一轮交给 AI 的问题</summary>
        <pre class="coding-diff">{{ coding.run.feedback }}</pre>
      </details>
    </div>
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
      <div class="coding-transcript" aria-live="polite" aria-label="编码 Agent 实时记录">
        <div v-if="coding.events.length === 0" class="empty-hint">等待编码 Agent 输出…</div>
        <div v-for="event in coding.events" :key="event.sequence" class="coding-event">
          <time>{{ new Date(event.at).toLocaleTimeString() }}</time>
          <strong :class="event.type">{{ EVENT_LABELS[event.type] }}</strong>
          <span>{{ event.text }}</span>
        </div>
      </div>

      <div v-if="coding.run.status === 'ready' && (coding.run.trigger === 'human' || coding.run.halt)" class="coding-result">
        <div class="coding-result-heading">
          <strong>
            逐个文件确认
            <TermHint term="patch" label="补丁" />
          </strong>
          <span v-if="coding.patchLoading">正在读取补丁…</span>
          <span v-else-if="coding.patch">已勾选 {{ coding.selectedFiles.length }} / {{ coding.patch.files.length }} 个文件</span>
        </div>
        <ul v-if="fileDiffs.length" class="coding-files">
          <li v-for="entry in fileDiffs" :key="entry.file.path">
            <details>
              <summary>
                <input
                  type="checkbox"
                  :aria-label="`应用 ${entry.file.path}`"
                  :checked="coding.selectedFiles.includes(entry.file.path)"
                  :disabled="!entry.applicable || coding.operation !== null"
                  @click.stop
                  @change="toggle(entry.file.path, $event)"
                />
                <code>{{ entry.file.path }}</code>
                <span>+{{ entry.file.added }} −{{ entry.file.removed }}</span>
                <strong v-if="entry.file.highRisk" class="risk-label">高风险</strong>
                <span v-if="coding.mergeOf(entry.file.path)?.state === 'merged'" class="merge-label">{{ MERGE_LABELS.merged }}</span>
                <strong v-if="coding.mergeOf(entry.file.path)?.state === 'conflict'" class="conflict-label">{{ MERGE_LABELS.conflict }}</strong>
                <span v-if="!entry.applicable" class="blocked-label">不能应用：{{ entry.reasons.join('；') }}</span>
              </summary>
              <div
                v-if="coding.mergeOf(entry.file.path)?.state === 'conflict' && coding.selectedFiles.includes(entry.file.path)"
                class="conflict-choice"
                role="radiogroup"
                :aria-label="`${entry.file.path} 的冲突怎么处理`"
              >
                <label v-for="choice in choicesFor(coding.mergeOf(entry.file.path)!)" :key="choice.value">
                  <input
                    type="radio"
                    :name="`resolve-${entry.file.path}`"
                    :value="choice.value"
                    :checked="coding.resolutions[entry.file.path] === choice.value"
                    :disabled="coding.operation !== null"
                    @change="coding.setResolution(entry.file.path, choice.value)"
                  />
                  {{ choice.label }}
                </label>
              </div>
              <div class="diff-body coding-diff-body">
                <div v-for="(line, index) in entry.lines" :key="index" class="diff-line" :class="line.kind">{{ line.text }}</div>
              </div>
            </details>
          </li>
        </ul>
        <label v-if="coding.highRisk" class="risk-consent">
          <input v-model="highRiskConsent" type="checkbox" />
          我已检查勾选的高风险文件的 diff，同意应用
        </label>
        <p v-if="coding.unresolved.length" class="coding-hint">还有 {{ coding.unresolved.length }} 个冲突的文件没选怎么处理。</p>
        <button class="primary-button" type="button" :disabled="applyDisabled" @click="apply">
          <AppIcon name="check" />
          应用勾选的文件并自动检查
        </button>
      </div>
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
      <div v-if="checks.length" class="coding-checks" aria-label="编码前置检查">
        <strong>前置检查</strong>
        <div v-for="entry in checks" :key="entry.kind">
          <span>{{ VERIFY_LABELS[entry.kind] }}</span>
          <span :class="entry.check.summary.ok ? 'check-pass' : 'check-fail'">{{ entry.check.summary.ok ? '通过' : '失败' }}</span>
        </div>
      </div>
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
.coding-event strong.error {
  color: var(--danger);
}
.coding-event strong.tool {
  color: var(--accent);
}
.coding-transcript {
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  font: var(--text-xs) var(--font-mono);
}
.coding-event {
  display: grid;
  grid-template-columns: 72px 54px 1fr;
  gap: 8px;
  padding: 3px 0;
}
.coding-event time,
.coding-event strong {
  color: var(--text-tertiary);
}
.coding-event span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.coding-result,
.coding-checks {
  display: grid;
  gap: 8px;
}
.coding-result-heading,
.coding-checks > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.coding-files {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}
.coding-files li {
  margin: 4px 0;
}
.coding-files summary {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}
.coding-files summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.coding-files .coding-diff-body {
  margin-top: 6px;
}
.risk-label {
  color: var(--danger);
}
.conflict-label {
  color: var(--warning);
}
.merge-label {
  color: var(--text-tertiary);
}
.conflict-choice {
  display: grid;
  gap: 4px;
  margin: 6px 0 4px 24px;
  font-size: var(--text-sm);
}
.conflict-choice label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.blocked-label {
  color: var(--danger);
}
.coding-rounds,
.coding-halt {
  font-size: var(--text-sm);
}
.coding-rounds ol {
  margin: 4px 0;
  padding-left: 20px;
  color: var(--text-secondary);
}
.coding-rounds .current {
  color: var(--text);
}
.coding-halt {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  color: var(--warning);
}
.risk-consent {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--warning);
  font-size: var(--text-sm);
}
.coding-diff {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  color: var(--text-secondary);
  font: var(--text-xs) var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.check-pass {
  color: var(--online);
}
.check-fail {
  color: var(--danger);
}
.empty-hint {
  margin: 0;
}
</style>

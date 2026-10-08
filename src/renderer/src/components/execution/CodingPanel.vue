<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useCodingStore } from '@/stores/coding.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();
const coding = useCodingStore();
const highRiskConsent = ref(false);

const STATUS_LABELS: Record<ipc.CodingRun['status'], string> = {
  preparing: '准备中',
  running: '编码中',
  checking: '检查中',
  ready: '待人工应用',
  applying: '应用中',
  applied: '已应用',
  failed: '失败',
  cancelled: '已取消',
  discarded: '已丢弃',
};
const CHECK_LABELS: Record<ipc.CheckKind, string> = { test: '测试', lint: 'Lint', build: 'Build', smoke: '冒烟测试' };

const canStart = computed(() => !!coding.runtime?.available && !coding.active && !!coding.instruction.trim() && !coding.operation);
const runError = computed(() => coding.run?.error);
const applyDisabled = computed(() => !coding.patch || coding.hasBlocked || (coding.highRisk && !highRiskConsent.value) || coding.operation !== null);
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
const fileNames = computed(() => coding.patch?.files.map((file) => file.path).join('、') || coding.run?.files.map((file) => file.path).join('、') || '暂无');

const checks = computed(() => Object.entries(coding.run?.checks ?? {}).flatMap(([kind, check]) => (check ? [{ kind: kind as ipc.CheckKind, check }] : [])));
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
          <p>独立 OS 用户执行；分析、审查和提交仍由人完成</p>
        </div>
      </div>
      <span v-if="coding.run" class="coding-status" :class="coding.run.status">{{ STATUS_LABELS[coding.run.status] }}</span>
    </div>

    <div v-if="coding.runtime && !coding.runtime.available" class="coding-offline" role="status">
      <AppIcon name="alert" />
      <div>
        <strong>编码运行时不可用</strong>
        <p>{{ coding.runtime.reason || '请先完成独立用户配置。' }}</p>
        <p>
          离线设置说明：在项目根目录人工运行
          <code>{{ coding.setupScript }}</code>
          ，TaskPilot 不会自动执行脚本。
        </p>
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
    <div v-if="coding.runtime && !coding.run" class="coding-meta" aria-label="当前编码运行时">
      <span>CLI：{{ coding.runtime.backend }}</span>
      <span>模型：{{ coding.runtime.config.model || 'CLI 默认模型' }}</span>
      <span>思考：{{ coding.runtime.config.thinking }}</span>
      <span>协议：{{ coding.runtime.protocol }}</span>
    </div>

    <div v-if="!coding.run || coding.run.status === 'failed'" class="coding-start">
      <label for="codingInstruction">开发者指令</label>
      <textarea
        id="codingInstruction"
        v-model="coding.instruction"
        rows="4"
        maxlength="12000"
        placeholder="描述要实现的代码变更、边界和验证方式"
        :disabled="!coding.runtime?.available || coding.operation !== null"
      ></textarea>
      <p class="coding-hint">启动是明确的人类操作；不会自动领取、提交、提交 QA、创建 commit 或 push。</p>
      <p v-if="runError" class="coding-error">
        <AppIcon name="alert" />
        {{ runError.code }}：{{ runError.message }}
      </p>
      <div class="coding-actions">
        <button v-if="coding.run?.status === 'failed'" class="secondary-button" type="button" :disabled="!canStart" @click="retry">
          <AppIcon name="refresh" />
          重试编码
        </button>
        <button v-else class="primary-button" type="button" :disabled="!canStart" @click="start">
          <AppIcon name="play" />
          明确开始编码
        </button>
      </div>
    </div>

    <template v-else>
      <div class="coding-meta">
        <span>用户：{{ coding.run.user }}</span>
        <span>CLI：{{ coding.run.cli }}</span>
        <span>模型：{{ coding.run.model || 'CLI 默认模型' }}</span>
        <span>思考：{{ coding.run.thinking }}</span>
        <span>Token：{{ tokenText }}</span>
        <span>费用：{{ cost }}</span>
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
          {{ coding.run.status === 'ready' ? '取消并丢弃结果' : '取消编码' }}
        </button>
      </div>

      <div class="coding-transcript" aria-live="polite" aria-label="编码 Agent 实时记录">
        <div v-if="coding.events.length === 0" class="empty-hint">等待编码 Agent 输出…</div>
        <div v-for="event in coding.events" :key="event.sequence" class="coding-event">
          <time>{{ new Date(event.at).toLocaleTimeString() }}</time>
          <strong>{{ event.type }}</strong>
          <span>{{ event.text }}</span>
        </div>
      </div>

      <div v-if="coding.run.status === 'ready'" class="coding-result">
        <div class="coding-result-heading">
          <strong>补丁待人工应用</strong>
          <span v-if="coding.patchLoading">正在读取补丁…</span>
        </div>
        <p>文件范围：{{ fileNames }}</p>
        <ul v-if="coding.patch?.files.length" class="coding-files">
          <li v-for="file in coding.patch.files" :key="file.path">
            <code>{{ file.path }}</code>
            <span>{{ file.added }} 行新增 · {{ file.removed }} 行删除</span>
            <strong v-if="file.highRisk" class="risk-label">高风险</strong>
          </li>
        </ul>
        <div v-if="coding.patch?.blocked.length" class="coding-blocked">
          <strong>阻止应用的条目</strong>
          <div v-for="entry in coding.patch.blocked" :key="`${entry.path}:${entry.reason}`">
            <code>{{ entry.path }}</code>
            ：{{ entry.reason }}
          </div>
        </div>
        <label v-if="coding.highRisk" class="risk-consent">
          <input v-model="highRiskConsent" type="checkbox" />
          我已检查原始 diff，并明确同意应用高风险文件
        </label>
        <button class="primary-button" type="button" :disabled="applyDisabled" @click="apply">
          <AppIcon name="check" />
          应用补丁
        </button>
        <p v-if="coding.patch" class="coding-diff-label">原始 diff（安全文本显示）</p>
        <pre v-if="coding.patch" class="coding-diff">{{ coding.patch.patch }}</pre>
      </div>
      <div v-if="coding.run.status === 'applied'" class="coding-applied" role="alert">
        <AppIcon name="alert" />
        已应用编码改动。运行验证或提交审查前，请确认命令会以当前主机用户权限执行，并再次人工检查文件范围。
      </div>
      <div v-if="checks.length" class="coding-checks" aria-label="编码前置检查">
        <strong>前置检查</strong>
        <div v-for="entry in checks" :key="entry.kind">
          <span>{{ CHECK_LABELS[entry.kind] }}</span>
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
.coding-files,
.coding-blocked {
  margin: 0;
  padding-left: 20px;
  font-size: var(--text-sm);
}
.coding-files li {
  margin: 4px 0;
}
.risk-label {
  margin-left: 8px;
  color: var(--danger);
}
.coding-blocked {
  color: var(--danger);
}
.risk-consent {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--warning);
  font-size: var(--text-sm);
}
.coding-diff-label {
  margin: 8px 0 0;
  color: var(--text-secondary);
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

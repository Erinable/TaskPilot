<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { PARSER_LABELS, SOURCE_LABELS, STEP_HINTS, stepIcon, stepLabel } from '@/lib/check_steps.ts';
import { stepInputId, stepStatusId, useSettingsStore } from '@/stores/settings.ts';
import FieldStatus from './FieldStatus.vue';
import type { StepMode } from '@/lib/settings_model.ts';
import type { CheckParser, StepKind } from '@shared/check_steps.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

// One check step: what runs now and where that comes from, and this
// machine's override. Common command lines are offered as options; any
// other can be typed.
const props = defineProps<{ id: workspaceTypes.CheckKind }>();

const settings = useSettingsStore();

const view = computed(() => settings.stepView(props.id));
const draft = computed(() => settings.workspaceDraft?.steps[props.id]);
const label = computed(() => stepLabel(props.id, view.value?.label ?? null));
const hint = computed(() => STEP_HINTS[props.id as StepKind] ?? '项目自定义的检查步骤');
const inputId = computed(() => stepInputId(props.id));
const statusId = computed(() => stepStatusId(props.id));
const status = computed(() => settings.statusOf(props.id));

const MODES: { value: StepMode; label: string; hint: string }[] = [
  { value: 'inherit', label: '用项目配置', hint: '按 taskpilot.toml 和预设运行' },
  { value: 'override', label: '本机自定义', hint: '只在这台电脑上改命令' },
  { value: 'off', label: '本机不运行', hint: '这台电脑上跳过这一步' },
];
const STAGES: { value: workspaceTypes.CheckStage; label: string }[] = [
  { value: 'submit', label: '提交前运行' },
  { value: 'step', label: '仅手动运行' },
];
const FORMATS = Object.entries(PARSER_LABELS).map(([value, text]) => ({ value: value as CheckParser['format'], label: text }));
const REPORT_PATHS = ['.taskpilot/reports/test.xml', 'reports/junit.xml'];

// Rows start folded; a step with an error or an edit in progress opens.
const expanded = ref(false);
watch(
  () => status.value.tone === 'error',
  (error) => {
    if (error) expanded.value = true;
  },
  { immediate: true },
);
const advancedOpen = ref(false);

// The row's pill: whether the step runs, and how.
const state = computed(() => {
  if (draft.value?.mode === 'off') return { text: '本机不运行', tone: '' };
  if (draft.value?.mode === 'override') return { text: '本机自定义', tone: 'in_progress' };
  if (!view.value?.effective) return { text: view.value?.skipped === 'disabled' ? '已关闭' : '未配置', tone: '' };
  return { text: view.value.effective.stage === 'submit' ? '提交前自动运行' : '手动运行', tone: 'done' };
});

// What runs, in one line for the summary.
const effectiveText = computed(() => {
  const effective = view.value?.effective;
  if (!effective) return view.value?.skipped === 'disabled' ? '已关闭' : '未配置，会跳过';
  return effective.lines.join(' && ');
});
const sourceText = computed(() => (view.value?.source ? SOURCE_LABELS[view.value.source] : ''));
const effectiveMeta = computed(() => {
  const effective = view.value?.effective;
  if (!effective) return '';
  return [effective.blocking ? '失败会拒绝审查' : '失败只提示', `结果按${PARSER_LABELS[effective.parser.format]}读取`].join(' · ');
});

// Options for the command picker: the preset's suggestions plus whatever
// is typed now.
const options = computed(() => [...new Set([...(view.value?.suggestions ?? []), ...(draft.value?.lines ?? [])].filter(Boolean))]);

const setMode = (mode: StepMode) => {
  if (!draft.value) return;
  expanded.value = true;
  draft.value.mode = mode;
  if (mode === 'override' && !draft.value.lines.length && view.value?.suggestions[0]) draft.value.lines = [view.value.suggestions[0]];
};

// A format change keeps the fields both formats share.
const setFormat = (format: CheckParser['format']) => {
  if (!draft.value) return;
  const previous = draft.value.parser as Record<string, unknown>;
  const path = typeof previous.path === 'string' ? previous.path : '';
  const parsers: Record<CheckParser['format'], CheckParser> = {
    tests: { format: 'tests' },
    exitcode: { format: 'exitcode' },
    junit: { format: 'junit', path: path || REPORT_PATHS[0] },
    json: { format: 'json', dialect: 'diagnostics', path: path || null },
    sarif: { format: 'sarif', path: path || null },
    regex: { format: 'regex', pattern: '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<message>.+)$', severity: 'error' },
  };
  draft.value.parser = parsers[format];
};
const parser = computed(() => draft.value?.parser as Record<string, unknown> | undefined);
const setParserField = (field: string, value: unknown) => {
  if (draft.value)
    draft.value.parser = {
      ...draft.value.parser,
      [field]: value === '' && field === 'path' && draft.value.parser.format !== 'junit' ? null : value,
    } as CheckParser;
};
const setTimeout = (value: number | null | undefined) => {
  if (draft.value) draft.value.timeoutSeconds = Number.isFinite(value) ? (value as number) : null;
};
</script>

<template>
  <div v-if="view && draft" class="step-row" :class="{ open: expanded, muted: !view.effective && draft.mode !== 'override' }" :data-step="id">
    <button class="step-summary" type="button" :aria-expanded="expanded" :aria-controls="`${inputId}-panel`" data-edit @click="expanded = !expanded">
      <AppIcon :name="stepIcon(id)" class="step-icon" />
      <span class="step-name">
        <strong>{{ label }}</strong>
        <small>{{ hint }}</small>
      </span>
      <code class="step-command" :title="effectiveText">{{ draft.mode === 'override' && draft.lines.length ? draft.lines.join(' && ') : effectiveText }}</code>
      <span class="status-pill" :class="state.tone">{{ state.text }}</span>
      <AppIcon :name="expanded ? 'chevron-down' : 'chevron-right'" class="step-chevron" />
    </button>
    <FieldStatus v-if="!expanded && status.tone" :id="statusId" :status="status" />
    <div v-if="expanded" :id="`${inputId}-panel`" class="step-panel">
      <div class="step-effective">
        <span>现在运行：</span>
        <code>{{ effectiveText }}</code>
        <span v-if="sourceText" class="scope-badge">来自 {{ sourceText }}</span>
        <small v-if="effectiveMeta">{{ effectiveMeta }}</small>
      </div>
      <div class="step-modes" role="radiogroup" :aria-label="`${label}在这台电脑上怎么运行`">
        <button
          v-for="mode in MODES"
          :key="mode.value"
          type="button"
          role="radio"
          class="step-mode"
          :class="{ selected: draft.mode === mode.value }"
          :aria-checked="draft.mode === mode.value"
          :data-mode="mode.value"
          @click="setMode(mode.value)"
        >
          <strong>{{ mode.label }}</strong>
          <small>{{ mode.hint }}</small>
        </button>
      </div>
      <template v-if="draft.mode === 'override'">
        <label class="step-field-label" :for="inputId">命令（可多条，按顺序运行）</label>
        <el-select
          :id="inputId"
          v-model="draft.lines"
          class="mono-input command-line"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="选一个常用命令，或直接输入后回车"
          :aria-describedby="statusId"
          :aria-invalid="String(status.tone === 'error')"
          :aria-label="`${label}的命令`"
        >
          <el-option v-for="line in options" :key="line" :label="line" :value="line" />
        </el-select>
        <FieldStatus :id="statusId" :status="status" />
        <div class="check-options" role="group" :aria-label="`${label}的运行方式`">
          <label class="check-option">
            <span>什么时候运行</span>
            <el-select v-model="draft.stage" class="stage-select" size="small" :aria-label="`${label}的运行时机`">
              <el-option v-for="stage in STAGES" :key="stage.value" :value="stage.value" :label="stage.label" />
            </el-select>
          </label>
          <el-checkbox v-model="draft.blocking" class="check-option">失败时拒绝审查</el-checkbox>
        </div>
        <button class="link-button step-advanced-toggle" type="button" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
          <AppIcon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" />
          高级选项：结果解析、超时、工作目录
        </button>
        <div v-if="advancedOpen" class="check-options step-advanced" role="group" :aria-label="`${label}的高级选项`">
          <label class="check-option">
            <span>结果解析</span>
            <el-select :model-value="draft.parser.format" class="parser-select" size="small" :aria-label="`${label}的解析方式`" @update:model-value="setFormat">
              <el-option v-for="format in FORMATS" :key="format.value" :value="format.value" :label="format.label" />
            </el-select>
          </label>
          <label class="check-option">
            <span>超时（秒）</span>
            <el-input-number
              :model-value="draft.timeoutSeconds"
              size="small"
              :min="1"
              :max="3600"
              controls-position="right"
              placeholder="600"
              :aria-label="`${label}的超时秒数`"
              @update:model-value="setTimeout"
            />
          </label>
          <label class="check-option grow">
            <span>工作目录</span>
            <el-input
              v-model="draft.cwd"
              class="mono-input"
              size="small"
              spellcheck="false"
              placeholder="留空为仓库根目录"
              :aria-label="`${label}的工作目录`"
            />
          </label>
          <label
            v-if="parser && (draft.parser.format === 'junit' || draft.parser.format === 'json' || draft.parser.format === 'sarif')"
            class="check-option grow"
          >
            <span>报告文件</span>
            <el-select
              :model-value="(parser.path as string | null) ?? ''"
              class="mono-input grow-select"
              size="small"
              filterable
              allow-create
              default-first-option
              :placeholder="draft.parser.format === 'junit' ? '必填，如 .taskpilot/reports/test.xml' : '留空则读取命令输出'"
              :aria-label="`${label}的报告文件`"
              @update:model-value="setParserField('path', $event)"
            >
              <el-option v-for="path in REPORT_PATHS" :key="path" :label="path" :value="path" />
            </el-select>
          </label>
          <label v-if="parser && draft.parser.format === 'json'" class="check-option">
            <span>JSON 格式</span>
            <el-select
              :model-value="parser.dialect"
              size="small"
              class="stage-select"
              :aria-label="`${label}的 JSON 格式`"
              @update:model-value="setParserField('dialect', $event)"
            >
              <el-option value="diagnostics" label="TaskPilot 诊断" />
              <el-option value="eslint" label="ESLint -f json" />
              <el-option value="cargo" label="Cargo --message-format=json" />
              <el-option value="ruff" label="Ruff --output-format=json" />
              <el-option value="mypy" label="mypy --output json" />
              <el-option value="pyright" label="Pyright --outputjson" />
            </el-select>
          </label>
          <label v-if="parser && draft.parser.format === 'regex'" class="check-option grow">
            <span>正则</span>
            <el-input
              :model-value="parser.pattern as string"
              class="mono-input"
              size="small"
              spellcheck="false"
              :aria-label="`${label}的正则`"
              @update:model-value="setParserField('pattern', $event)"
            />
          </label>
        </div>
      </template>
      <FieldStatus v-else :id="statusId" :status="status" />
    </div>
  </div>
</template>

<style scoped>
.step-row + .step-row {
  border-top: 1px solid var(--line-soft);
}
.step-summary {
  display: grid;
  grid-template-columns: 20px minmax(140px, 220px) minmax(0, 1fr) auto 14px;
  gap: var(--space-3);
  align-items: center;
  width: 100%;
  padding: 12px 16px;
  color: var(--text);
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.step-summary:hover {
  background: var(--fill-hover);
}
.step-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.step-icon,
.step-chevron {
  width: 16px;
  height: 16px;
  color: var(--text-muted);
}
.step-name {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.step-name small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.step-command {
  overflow: hidden;
  color: var(--text-secondary);
  font: var(--text-sm) var(--font-mono);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.step-row.muted .step-command,
.step-row.muted .step-name strong {
  color: var(--text-muted);
}
.step-panel {
  display: grid;
  gap: var(--space-3);
  padding: 0 16px 16px 48px;
}
.step-effective {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.step-effective code {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.step-modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}
.step-mode {
  display: grid;
  gap: 2px;
  padding: 8px 12px;
  color: var(--text);
  text-align: left;
  background: var(--fill);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.step-mode small {
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.step-mode:hover {
  background: var(--fill-hover);
}
.step-mode.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.step-mode:focus-visible {
  outline: 2px solid var(--accent);
}
.step-field-label {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.step-advanced-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  justify-self: start;
  padding: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  background: none;
  border: 0;
  cursor: pointer;
}
.step-advanced-toggle .icon {
  width: 13px;
  height: 13px;
}
.step-advanced {
  padding: 10px 12px;
  background: var(--fill);
  border-radius: var(--radius-md);
}
.mono-input :deep(input),
.mono-input :deep(.el-select__selected-item) {
  font-family: var(--font-mono);
}
.command-line {
  width: 100%;
}
.stage-select,
.parser-select {
  width: 160px;
}
.grow-select {
  flex: 1;
  min-width: 0;
}
@media (max-width: 820px) {
  .step-summary {
    grid-template-columns: 20px 1fr auto 14px;
  }
  .step-command {
    display: none;
  }
  .step-modes {
    grid-template-columns: 1fr;
  }
}
</style>

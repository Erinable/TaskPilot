<script setup lang="ts">
import { computed } from 'vue';

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

const MODES: { value: StepMode; label: string }[] = [
  { value: 'inherit', label: '跟随项目' },
  { value: 'override', label: '本机覆盖' },
  { value: 'off', label: '本机关闭' },
];
const STAGES: { value: workspaceTypes.CheckStage; label: string }[] = [
  { value: 'submit', label: '提交前运行' },
  { value: 'step', label: '仅手动运行' },
];
const FORMATS = Object.entries(PARSER_LABELS).map(([value, text]) => ({ value: value as CheckParser['format'], label: text }));
const REPORT_PATHS = ['.taskpilot/reports/test.xml', 'reports/junit.xml'];

// What runs, in one line for the summary.
const effectiveText = computed(() => {
  const effective = view.value?.effective;
  if (!effective) return view.value?.skipped === 'disabled' ? '已关闭' : '未配置，跳过';
  return effective.lines.join(' && ');
});
const sourceText = computed(() => (view.value?.source ? SOURCE_LABELS[view.value.source] : ''));
const effectiveMeta = computed(() => {
  const effective = view.value?.effective;
  if (!effective) return '';
  return [effective.stage === 'submit' ? '提交前运行' : '仅手动', effective.blocking ? '失败时拒绝' : '仅提示', PARSER_LABELS[effective.parser.format]].join(
    ' · ',
  );
});

// Options for the command picker: the preset's suggestions plus whatever
// is typed now.
const options = computed(() => [...new Set([...(view.value?.suggestions ?? []), ...(draft.value?.lines ?? [])].filter(Boolean))]);

const setMode = (mode: StepMode) => {
  if (!draft.value) return;
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
  <div v-if="view && draft" class="setting-row stacked step-card" :data-step="id">
    <div class="step-head">
      <label class="setting-label" :for="inputId">
        <strong>
          <AppIcon :name="stepIcon(id)" />
          {{ label }}
        </strong>
        <small>{{ hint }}</small>
      </label>
      <el-radio-group :model-value="draft.mode" size="small" :aria-label="`${label}在本机的设置方式`" @update:model-value="setMode($event as StepMode)">
        <el-radio-button v-for="mode in MODES" :key="mode.value" :value="mode.value" :data-mode="mode.value">{{ mode.label }}</el-radio-button>
      </el-radio-group>
    </div>
    <div class="step-effective" :class="{ skipped: !view.effective }">
      <span class="step-effective-label">现在运行</span>
      <code>{{ effectiveText }}</code>
      <span v-if="sourceText" class="scope-badge">{{ sourceText }}</span>
      <small v-if="effectiveMeta">{{ effectiveMeta }}</small>
    </div>
    <template v-if="draft.mode === 'override'">
      <el-select
        :id="inputId"
        v-model="draft.lines"
        class="mono-input command-line"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        placeholder="选一个常用命令，或直接输入后回车；多条按顺序运行"
        :aria-describedby="statusId"
        :aria-invalid="String(status.tone === 'error')"
        :aria-label="`${label}的命令`"
      >
        <el-option v-for="line in options" :key="line" :label="line" :value="line" />
      </el-select>
      <FieldStatus :id="statusId" :status="status" />
      <div class="check-options" role="group" :aria-label="`${label}的运行方式`">
        <label class="check-option">
          <span>运行时机</span>
          <el-select v-model="draft.stage" class="stage-select" size="small" :aria-label="`${label}的运行时机`">
            <el-option v-for="stage in STAGES" :key="stage.value" :value="stage.value" :label="stage.label" />
          </el-select>
        </label>
        <el-checkbox v-model="draft.blocking" class="check-option">失败时拒绝</el-checkbox>
        <label class="check-option">
          <span>解析方式</span>
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
          <el-input v-model="draft.cwd" class="mono-input" size="small" spellcheck="false" placeholder="留空为仓库根目录" :aria-label="`${label}的工作目录`" />
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
            :placeholder="draft.parser.format === 'junit' ? '必填，如 .taskpilot/reports/test.xml' : '留空则读取标准输出'"
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
</template>

<style scoped>
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.step-effective {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.step-effective code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.step-effective.skipped code {
  color: var(--text-muted);
}
.step-effective-label,
.step-effective small {
  color: var(--text-muted);
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
</style>

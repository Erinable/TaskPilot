// How the renderer names and draws check steps, so the execution page, the
// review and settings say the same thing for each one.
import { CUSTOM_PREFIX, isCustomStepId } from '@shared/check_steps.ts';
import type { IconName } from './icons.ts';
import type { CheckParser, Diagnostic, StepId, StepKind } from '@shared/check_steps.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

export const STEP_LABELS: Record<StepKind, string> = {
  setup: '环境准备',
  build: '构建',
  format: '格式检查',
  lint: '代码检查',
  typecheck: '类型检查',
  test: '测试',
  coverage: '覆盖率',
};

export const STEP_ICONS: Record<StepKind, IconName> = {
  setup: 'box',
  build: 'blocks',
  format: 'list',
  lint: 'wand',
  typecheck: 'check-circle',
  test: 'flask',
  coverage: 'target',
};

export const STEP_HINTS: Record<StepKind, string> = {
  setup: '安装依赖、准备工具链。只在你点击时运行。',
  build: '把代码编译或打包，能发现编译错误。',
  format: '检查代码格式是否符合项目的格式化规则。',
  lint: '检查写法问题，比如没用到的变量。',
  typecheck: '检查类型是否对得上，不运行代码。',
  test: '运行自动化测试。结果会关联到验收条件。',
  coverage: '统计测试覆盖了多少代码。',
};

// Custom steps TaskPilot itself names: v2's smoke check became custom:smoke.
const KNOWN_CUSTOM: Record<string, string> = { 'custom:smoke': '冒烟测试', 'custom:hidden-tests': '隐藏测试' };

// A custom step's own label, else its name.
export const stepLabel = (id: StepId | string, label: string | null = null) =>
  label ?? KNOWN_CUSTOM[id] ?? (isCustomStepId(id) ? id.slice(CUSTOM_PREFIX.length) : (STEP_LABELS[id as StepKind] ?? id));

export const stepIcon = (id: StepId | string): IconName => STEP_ICONS[id as StepKind] ?? 'terminal';

export const PARSER_LABELS: Record<CheckParser['format'], string> = {
  tests: '测试输出（TAP / spec / libtest）',
  junit: 'JUnit 报告文件',
  json: 'JSON 诊断',
  sarif: 'SARIF',
  regex: '正则逐行匹配',
  exitcode: '只看退出码',
};

export const SOURCE_LABELS: Record<NonNullable<workspaceTypes.StepView['source']>, string> = {
  local: '本机设置',
  project: 'taskpilot.toml',
  preset: '预设',
};

export const SEVERITY_LABELS: Record<Diagnostic['severity'], string> = { error: '错误', warning: '警告', info: '提示' };

// `file:line:column`, as far as the diagnostic knows.
export const diagnosticPlace = (item: Diagnostic) => (item.file ? [item.file, item.line, item.column].filter((part) => part !== null).join(':') : '');

import fs from 'node:fs/promises';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import type { ComplexityFinding, ComplexityRegression } from './complexity_analysis.ts';

type Outcome = 'success' | 'failure' | 'skipped' | 'cancelled';
type DuplicateLocation = { name: string; start: number; end: number };
type DuplicateReport = {
  statistics: { total: { clones: number; duplicatedLines: number; percentage: number } };
  duplicates: { firstFile: DuplicateLocation; secondFile: DuplicateLocation; lines: number }[];
};
type ComplexityReport = { base: string | null; findings: ComplexityFinding[]; regressions: ComplexityRegression[] };

const MAX_ROWS = 20;
const MAX_LOG_LENGTH = 6000;
const LABELS: Record<Outcome, string> = { success: '通过', failure: '失败', skipped: '未运行', cancelled: '已取消' };
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '\r': ' ', '\n': ' ' };
const code = (value: unknown) => `<code>${String(value).replace(/[&<>|`\r\n]/g, (character) => ENTITIES[character])}</code>`;
const outcome = (value: string): Outcome => {
  if (value === 'success' || value === 'failure' || value === 'skipped' || value === 'cancelled') return value;
  throw new Error(`Unknown analysis outcome: ${value}`);
};
const report = async <T>(status: Outcome, filePath: string, render: (value: T) => string): Promise<string> => {
  if (status === 'skipped' || status === 'cancelled') return '未生成结果，请查看前置步骤或取消状态。';
  try {
    return render(JSON.parse(await fs.readFile(filePath, 'utf8')) as T);
  } catch (error) {
    return `报告不可用：${code(filePath)}。${code(error instanceof Error ? error.message : error)}`;
  }
};

const duplicates = (value: DuplicateReport) => {
  const total = value.statistics.total;
  if (![total.clones, total.duplicatedLines, total.percentage].every(Number.isFinite) || !Array.isArray(value.duplicates))
    throw new Error('Invalid duplicate report');
  const rows = [...value.duplicates]
    .sort((left, right) => right.lines - left.lines)
    .slice(0, MAX_ROWS)
    .map(
      (item) =>
        `| ${code(`${item.firstFile.name}:${item.firstFile.start}-${item.firstFile.end}`)} | ${code(`${item.secondFile.name}:${item.secondFile.start}-${item.secondFile.end}`)} | ${item.lines} |`,
    );
  return [
    `${total.clones} 个重复块，${total.duplicatedLines} 行重复代码，重复率 ${total.percentage.toFixed(2)}%。重复率超过 .jscpd.json 的 threshold 时失败。`,
    ...(rows.length ? ['', '| 位置一 | 位置二 | 重复行数 |', '| --- | --- | ---: |', ...rows] : []),
    ...(value.duplicates.length > MAX_ROWS ? ['', `仅显示重复行数最多的 ${MAX_ROWS} 项，完整结果见附件。`] : []),
  ].join('\n');
};

const complexity = (value: ComplexityReport) => {
  if (!Array.isArray(value.findings) || !Array.isArray(value.regressions)) throw new Error('Invalid complexity report');
  const rows = [...value.findings]
    .sort((left, right) => right.complexity - left.complexity)
    .slice(0, MAX_ROWS)
    .map((item) => {
      const regression = value.regressions.find((entry) => entry.filePath === item.filePath && entry.functionId === item.functionId);
      const change = regression ? (regression.previous === null ? '新增' : `${regression.previous} → ${regression.complexity}`) : '既有超限';
      return `| ${code(`${item.filePath}:${item.line}`)} | ${code(item.functionId)} | ${item.complexity} / ${item.limit} | ${change} |`;
    });
  return [
    `${value.findings.length} 个超限函数，${value.regressions.length} 个新增或加重的问题。`,
    `比较基线：${value.base ? code(value.base) : '未比较基线'}。`,
    ...(rows.length ? ['', '| 位置 | 函数 | 复杂度 / 阈值 | 变化 |', '| --- | --- | ---: | --- |', ...rows] : []),
    ...(value.findings.length > MAX_ROWS ? ['', `仅显示复杂度最高的 ${MAX_ROWS} 项，完整结果见附件。`] : []),
  ].join('\n');
};

const cycles = async (status: Outcome) => {
  if (status === 'skipped' || status === 'cancelled') return '未生成结果，请查看前置步骤或取消状态。';
  const result = status === 'success' ? '未发现静态运行时循环依赖或未解析导入。' : '检查失败，请查看以下诊断及完整日志。';
  try {
    const log = stripVTControlCharacters(await fs.readFile('.taskpilot/analysis/cycles/knip.log', 'utf8')).trim();
    const excerpt = log.slice(0, MAX_LOG_LENGTH);
    const fence = '`'.repeat(Math.max(3, ...[...excerpt.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return [result, '', `${fence}text`, excerpt || '无诊断输出。', fence, ...(log.length > MAX_LOG_LENGTH ? ['', '日志已截断，完整结果见附件。'] : [])].join(
      '\n',
    );
  } catch {
    return `${result}\n\n诊断日志不可用，请查看检查步骤的输出。`;
  }
};

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    duplicates: { type: 'string', default: 'skipped' },
    complexity: { type: 'string', default: 'skipped' },
    cycles: { type: 'string', default: 'skipped' },
  },
});
if (!values.output) throw new Error('--output is required');
const duplicateOutcome = outcome(values.duplicates);
const complexityOutcome = outcome(values.complexity);
const cycleOutcome = outcome(values.cycles);
const sections = await Promise.all([
  report(duplicateOutcome, '.taskpilot/analysis/duplicates/jscpd-report.json', duplicates),
  report(complexityOutcome, '.taskpilot/analysis/complexity/complexity-report.json', complexity),
  cycles(cycleOutcome),
]);
await fs.appendFile(
  values.output,
  [
    '# Code analysis',
    '',
    '| 检查 | 状态 |',
    '| --- | --- |',
    `| 重复代码 | ${LABELS[duplicateOutcome]} |`,
    `| 函数复杂度 | ${LABELS[complexityOutcome]} |`,
    `| 循环依赖与未解析导入 | ${LABELS[cycleOutcome]} |`,
    '',
    '## 重复代码',
    '',
    sections[0],
    '',
    '## 函数复杂度',
    '',
    sections[1],
    '',
    '## 循环依赖与未解析导入',
    '',
    sections[2],
    '',
    '完整报告见本次运行的 Artifacts：`duplicate-code-report`、`complexity-report`、`cycle-dependency-report`，保留 14 天。',
    '',
  ].join('\n'),
);

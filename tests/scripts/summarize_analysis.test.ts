import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, onTestFinished, test } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/summarize_analysis.ts', import.meta.url));
const fixture = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-summary-'));
  onTestFinished(() => fs.rm(cwd, { recursive: true, force: true }));
  const write = async (name: string, content: string) => {
    const filePath = path.join(cwd, '.taskpilot/analysis', name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  };
  const run = async (duplicates: string, complexity: string, cycles: string) => {
    const output = path.join(cwd, 'summary.md');
    await fs.writeFile(output, 'Existing summary\n');
    await execute(process.execPath, [script, '--output', output, '--duplicates', duplicates, '--complexity', complexity, '--cycles', cycles], { cwd });
    return fs.readFile(output, 'utf8');
  };
  return { write, run };
};

test('summarizes successful reports and appends to the GitHub summary file', async () => {
  const { write, run } = await fixture();
  await write('duplicates/jscpd-report.json', JSON.stringify({ statistics: { total: { clones: 0, duplicatedLines: 0, percentage: 0 } }, duplicates: [] }));
  await write('complexity/complexity-report.json', JSON.stringify({ base: 'abc123', findings: [], regressions: [] }));
  await write('cycles/knip.log', 'No issues found\n');
  const output = await run('success', 'success', 'success');
  expect(output).toContain('Existing summary\n# Code analysis');
  expect(output).toContain('重复率 0.00%');
  expect(output).toContain('0 个超限函数，0 个新增或加重的问题');
  expect(output).toContain('<code>abc123</code>');
  expect(output).toContain('未发现静态运行时循环依赖或未解析导入');
  expect(output).toContain('cycle-dependency-report');
});

test('keeps failed diagnostics readable while escaping and limiting report content', async () => {
  const { write, run } = await fixture();
  const duplicate = { firstFile: { name: 'src/<name>|`.ts', start: 1, end: 20 }, secondFile: { name: 'src/other.ts', start: 2, end: 21 }, lines: 20 };
  await write(
    'duplicates/jscpd-report.json',
    JSON.stringify({ statistics: { total: { clones: 21, duplicatedLines: 420, percentage: 1.234 } }, duplicates: Array.from({ length: 21 }, () => duplicate) }),
  );
  const finding = { filePath: 'src/a.ts', line: 9, column: 1, functionId: 'variable:load#1', complexity: 24, limit: 20 };
  await write('complexity/complexity-report.json', JSON.stringify({ base: 'base', findings: [finding], regressions: [{ ...finding, previous: 22 }] }));
  await write('cycles/knip.log', `\u001b[31mCircular dependency\u001b[0m\n\x60\x60\x60\n${'x'.repeat(7000)}`);
  const output = await run('success', 'failure', 'failure');
  expect(output).toContain('src/&lt;name&gt;&#124;&#96;.ts:1-20');
  expect(output).toContain('重复率 1.23%');
  expect(output).toContain('仅显示重复行数最多的 20 项');
  expect(output).toContain('| 函数复杂度 | 失败 |');
  expect(output).toContain('24 / 20 | 22 → 24');
  expect(output).toContain('````text\nCircular dependency\n```');
  expect(output).not.toContain('\u001b');
  expect(output).toContain('日志已截断');
});

test('distinguishes missing or invalid reports from checks that never ran', async () => {
  const { write, run } = await fixture();
  await write('complexity/complexity-report.json', '{invalid');
  const output = await run('failure', 'failure', 'skipped');
  expect(output.match(/报告不可用/g)).toHaveLength(2);
  expect(output).toContain('| 循环依赖与未解析导入 | 未运行 |');
  expect(output).not.toContain('未发现静态运行时循环依赖');
});

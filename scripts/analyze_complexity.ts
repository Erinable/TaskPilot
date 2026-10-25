import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as analysis from './complexity_analysis.ts';

const { values } = parseArgs({ options: { base: { type: 'string' }, check: { type: 'boolean', default: false } } });
const cwd = process.cwd();
const current = await analysis.analyzeSources(await analysis.readCurrentSources(cwd), cwd);
const reference = values.check ? (values.base ?? 'HEAD') : values.base;
const baseline = reference ? await analysis.readBaselineSources(cwd, reference, current) : null;
const previous = baseline ? await analysis.analyzeSources(baseline.sources, cwd) : [];
const regressions = baseline ? analysis.findRegressions(current, previous) : [];
const reportPath = path.join(cwd, '.taskpilot/analysis/complexity/complexity-report.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify({ base: baseline?.revision ?? null, findings: current, regressions }, null, 2)}\n`);
for (const finding of current)
  console.log(`${finding.filePath}:${finding.line}:${finding.column} complexity=${finding.complexity} limit=${finding.limit} ${finding.functionId}`);
console.log(`${current.length} functions exceed the configured complexity limit. Report: ${path.relative(cwd, reportPath)}`);
if (baseline) {
  for (const regression of regressions)
    console.error(`${regression.filePath}:${regression.line} ${regression.functionId}: ${regression.previous ?? 'new'} -> ${regression.complexity}`);
  console.log(`${regressions.length} new or worsened complexity issues compared with ${baseline.revision}.`);
}
if (values.check && regressions.length) process.exitCode = 1;

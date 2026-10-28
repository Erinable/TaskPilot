/** @module-tag integration */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { gitRepo } from '../fixtures/git_repo.ts';
import * as analysis from '../../scripts/complexity_analysis.ts';

const execute = promisify(execFile);
const cwd = process.cwd();
const functionSource = (name: string, branches: number) =>
  `export const ${name} = (flags: boolean[]) => { ${Array.from({ length: branches }, (_, index) => `if (flags[${index}]) return ${index};`).join(' ')} return -1; };`;
const source = (text: string, filePath = 'src/complexity_fixture.ts'): analysis.SourceEntry => ({ filePath, source: text });

test('uses ESLint complexity for TypeScript and Vue script blocks, including optional chaining', async () => {
  const findings = await analysis.analyzeSources(
    [source(functionSource('typescriptExample', 20)), source(`<script lang="ts">${functionSource('vueExample', 21)}</script>`, 'src/complexity_fixture.vue')],
    cwd,
  );
  expect(findings.map((finding) => [finding.filePath, finding.complexity, finding.limit])).toEqual([
    ['src/complexity_fixture.vue', 22, 20],
    ['src/complexity_fixture.ts', 21, 20],
  ]);
  const optional = `export const chained = (value: { next?: { enabled?: boolean } }) => ${Array.from({ length: 11 }, () => 'value.next?.enabled').join(' || ')};`;
  expect((await analysis.analyzeSources([source(optional)], cwd))[0].complexity).toBe(22);
});

test('existing debt and improvements pass even when functions move to different lines', async () => {
  const previous = await analysis.analyzeSources([source(`${functionSource('existing', 22)}\n${functionSource('other', 20)}`)], cwd);
  const current = await analysis.analyzeSources([source(`\n\n${functionSource('other', 20)}\n${functionSource('existing', 21)}`)], cwd);
  expect(analysis.findRegressions(current, previous)).toEqual([]);
});

test('identifies class and object method diagnostics whose locations precede the function node', async () => {
  const branches = Array.from({ length: 20 }, (_, index) => `if (flags[${index}]) return ${index};`).join(' ');
  const findings = await analysis.analyzeSources(
    [source(`export class Example { async load(flags: boolean[]) { ${branches} } }\nexport const object = { load(flags: boolean[]) { ${branches} } };`)],
    cwd,
  );
  expect(findings).toHaveLength(2);
  expect(findings.map((finding) => finding.complexity)).toEqual([21, 21]);
  expect(new Set(findings.map((finding) => finding.functionId)).size).toBe(2);
});

test('new complex functions and worsened functions fail individually without offsetting deleted debt', async () => {
  const previous = await analysis.analyzeSources([source(`${functionSource('existing', 20)}\n${functionSource('deleted', 30)}`)], cwd);
  const current = await analysis.analyzeSources([source(`${functionSource('existing', 21)}\n${functionSource('newFunction', 20)}`)], cwd);
  const regressions = analysis.findRegressions(current, previous);
  expect(regressions).toHaveLength(2);
  expect(regressions.map((finding) => [finding.previous, finding.complexity])).toEqual([
    [21, 22],
    [null, 21],
  ]);
});

test('distinguishes same-named helpers in different named scopes', async () => {
  const container = (name: string, branches: number) =>
    `export const ${name} = () => { ${functionSource('helper', branches).replace('export ', '')} return helper; };`;
  const previous = await analysis.analyzeSources([source(`${container('first', 22)}\n${container('second', 20)}`)], cwd);
  const current = await analysis.analyzeSources([source(`${container('first', 20)}\n${container('second', 21)}`)], cwd);
  const regressions = analysis.findRegressions(current, previous);
  expect(regressions).toHaveLength(1);
  expect(regressions[0].functionId).toContain('second');
  expect(regressions[0].previous).toBe(21);
});

test('cannot hide complexity through inline disables and fails on parse errors', async () => {
  const findings = await analysis.analyzeSources([source(`// eslint-disable complexity\n${functionSource('disabled', 20)}`)], cwd);
  expect(findings).toHaveLength(1);
  await expect(analysis.analyzeSources([source('export const = ;')], cwd)).rejects.toThrow(/Parsing error/);
});

const temporaryRepository = async () => (await gitRepo({ 'src/original.ts': functionSource('existing', 20) }, { prefix: 'taskpilot-complexity-test-' })).root;

test('reads renamed baselines and includes untracked source without reading missing or declaration files', async () => {
  const directory = await temporaryRepository();
  await execute('git', ['mv', 'src/original.ts', 'src/renamed.ts'], { cwd: directory });
  await fs.writeFile(path.join(directory, 'src/new.ts'), functionSource('added', 20));
  await fs.writeFile(path.join(directory, 'src/globals.d.ts'), 'declare const value: boolean;');
  const current = await analysis.readCurrentSources(directory);
  expect(current.map((entry) => entry.filePath).sort()).toEqual(['src/new.ts', 'src/renamed.ts']);
  const findings = await analysis.analyzeSources(current, cwd);
  const baseline = await analysis.readBaselineSources(directory, 'HEAD', findings);
  expect(baseline.sources).toEqual([{ filePath: 'src/renamed.ts', source: functionSource('existing', 20) }]);
  expect(analysis.findRegressions(findings, await analysis.analyzeSources(baseline.sources, cwd))).toHaveLength(1);
  await expect(analysis.readBaselineSources(directory, 'missing-reference', findings)).rejects.toThrow();
  await fs.unlink(path.join(directory, 'src/renamed.ts'));
  expect((await analysis.readCurrentSources(directory)).map((entry) => entry.filePath)).toEqual(['src/new.ts']);
});

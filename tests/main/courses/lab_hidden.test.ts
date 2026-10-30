/** @module-tag integration */
// A course lab's hidden tests at review (src/main/courses/lab_hidden.ts), with a fake
// grader: what it is handed and what the review gets back.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';
import * as labs from '../../../src/main/courses/labs.ts';
import { HIDDEN_CHECK_KIND, runHiddenTests } from '../../../src/main/courses/lab_hidden.ts';
import type { Grader, GradeRun } from '../../../src/main/courses/lab_verify.ts';
import type { ToolchainProbe } from '../../../src/main/courses/lab_toolchain.ts';
import type { LabToolchainCheck } from '../../../src/shared/ipc/requirements.ts';

const run = promisify(execFile);

const HIDDEN = '#!/bin/sh\n# secret input 7 -> 42\necho "ok - 边界情况"\n';

const setup = async () => {
  const base = await tempDir('taskpilot-hidden-');
  const root = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests/public'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '/build/\n');
  await fs.writeFile(path.join(root, 'src/a.c'), 'int a;\n');
  await fs.writeFile(path.join(root, 'tests/public/01_a.sh'), 'echo "ok - public"\n');
  await run('git', ['init', '-q', root]);
  await run('git', ['-C', root, 'add', '.']);
  // The student's own edits: a new file, a changed Makefile, build output, a secret.
  await fs.writeFile(path.join(root, 'src/b.c'), 'int b;\n');
  await fs.writeFile(path.join(root, 'Makefile'), 'grade:\n\techo pass\n');
  await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'build/a.o'), 'x');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=1\n');
  await labs.writePrivate(dataDir, 'a', { reference: 'r', hidden: { '01_a_edge.sh': HIDDEN }, hints: [], verify: null });
  return { root, dataDir };
};

const fake =
  (result: GradeRun, seen: Record<string, string>[] = []): Grader =>
  async (files) => {
    seen.push(files);
    return result;
  };

// A probe that finds the toolchain, or not; `seen` lists the toolchains asked about.
const probeOf =
  (ready = true, seen: string[] = []): ToolchainProbe =>
  async (toolchain): Promise<LabToolchainCheck> => {
    seen.push(toolchain);
    return { id: toolchain, tools: [{ command: 'python3', version: ready ? 'Python 3.12.0' : null, install: 'brew install python' }], ready, problem: null };
  };
const probe = probeOf();

test('the hidden tests run on the working tree with TaskPilot’s scaffolding and only the hidden test files', async () => {
  const { root, dataDir } = await setup();
  const seen: Record<string, string>[] = [];
  const outcome = await runHiddenTests({
    root,
    dataDir,
    labId: 'a',
    grader: fake({ built: true, results: { 边界情况: true }, output: 'ok - 边界情况' }, seen),
    probe,
  });
  assert.deepEqual(Object.keys(seen[0]).sort(), ['.gitignore', 'Makefile', 'src/a.c', 'src/b.c', 'tests/grade.sh', 'tests/public/01_a_edge.sh']);
  assert.equal(seen[0].Makefile, labs.MAKEFILE, 'the student’s Makefile is replaced');
  assert.equal(outcome!.evidence.kind, HIDDEN_CHECK_KIND);
  assert.deepEqual([outcome!.evidence.status, outcome!.evidence.blocking], ['pass', true]);
  assert.ok(!('error' in outcome!.run) && outcome!.run.output === '', 'the output is never kept');
});

test('a failing hidden test fails the check by name; a broken build fails it too', async () => {
  const { root, dataDir } = await setup();
  const failed = await runHiddenTests({ root, dataDir, labId: 'a', probe, grader: fake({ built: true, results: { 边界情况: false }, output: '7 -> 42' }) });
  assert.deepEqual([failed!.evidence.status, failed!.evidence.reason, failed!.evidence.newFailures], ['fail', 'hidden_failed', ['边界情况']]);
  assert.ok(!JSON.stringify(failed).includes('42'), 'nothing of the script or its output is kept');
  const broken = await runHiddenTests({ root, dataDir, labId: 'a', probe, grader: fake({ built: false, results: {}, output: 'cc: error' }) });
  assert.deepEqual([broken!.evidence.status, broken!.evidence.reason], ['fail', 'crashed']);
});

test('a lab without hidden tests has no check, and a grader that cannot run leaves it unverifiable', async () => {
  const { root, dataDir } = await setup();
  assert.equal(await runHiddenTests({ root, dataDir, labId: 'none', probe, grader: fake({ built: true, results: {}, output: '' }) }), null);
  const refusal = Object.assign(new Error('no sandbox'), { code: 'sandbox_unavailable' });
  const refused: Grader = async () => {
    throw refusal;
  };
  captureExpectedErrors((error) => error === refusal);
  const outcome = await runHiddenTests({ root, dataDir, labId: 'a', probe, grader: refused });
  assert.deepEqual([outcome!.evidence.status, outcome!.evidence.reason], ['unverifiable', 'sandbox_unavailable']);
});

test("the repository's toolchain is probed first: missing, the check is unverifiable and nothing runs", async () => {
  const { root, dataDir } = await setup();
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'course = "programming"\ntoolchain = "python"\n');
  const asked: string[] = [];
  const seen: Record<string, string>[] = [];
  captureExpectedErrors((error) => (error as { code?: string }).code === 'toolchain_missing');
  const missing = await runHiddenTests({
    root,
    dataDir,
    labId: 'a',
    probe: probeOf(false, asked),
    grader: fake({ built: true, results: {}, output: '' }, seen),
  });
  assert.deepEqual([missing!.evidence.status, missing!.evidence.reason], ['unverifiable', 'toolchain_missing']);
  assert.deepEqual([asked, seen.length], [['python'], 0]);
  const toolchains: (string | null)[] = [];
  const grader: Grader = async (_files, options) => {
    toolchains.push(options.toolchain);
    return { built: true, results: { 边界情况: true }, output: '' };
  };
  const graded = await runHiddenTests({ root, dataDir, labId: 'a', probe, grader });
  assert.deepEqual([graded!.evidence.status, toolchains], ['pass', ['python']]);
});

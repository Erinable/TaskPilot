/** @module-tag integration */
// The lab self-check (src/main/courses/lab_verify.ts): each of the four checks on
// faked `make grade` results, the rounds and repairs, and the whole check on
// a real lab under the offline Seatbelt profile.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as labVerify from '../../../src/main/courses/lab_verify.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';
import { SANDBOX_EXEC_PATH } from '../../../src/main/coding/coding_sandbox.ts';
import { HIDDEN_NAMES, IDLE_LAB, PUBLIC_NAMES, RR_LAB, RR_MUTANT_EDITS, allTests, graded, mutated } from '../../fixtures/lab_verify.ts';
import { RR_SPEC } from '../../fixtures/lab_generator.ts';
import { buildRules } from '../../../src/shared/lab_toolchains.ts';
import * as requiredTools from '../../fixtures/required_tools.ts';
import type { GeneratedLab } from '../../../src/main/agents/lab_generator.ts';
import type { Grader, VerifyDeps } from '../../../src/main/courses/lab_verify.ts';
import type { ToolchainProbe } from '../../../src/main/courses/lab_toolchain.ts';

const sandboxed = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC_PATH);
const hasRustc = await requiredTools.hasTools('rustc');
const unbuilt = { built: false, results: {}, output: 'cc: error' };
const mutant = (description: string) => ({ description, files: [] });
// A first-stage C lab: TaskPilot's scaffolding, the round-robin program built alone.
const TARGET: labVerify.Target = { stage: 1, base: labVerify.FIRST_STAGE_BASE, toolchain: 'c', programs: [] };
const readyProbe: ToolchainProbe = async (toolchain) => ({ id: toolchain, tools: [], ready: true, problem: null });

// ========== reference ==========

test('reference passes when every test the run reports passes, earlier stages included', () => {
  assert.deepEqual(labVerify.checkReference(graded({ ...allTests(true), 'fcfs from stage 1': true }), RR_LAB), { pass: true, detail: [], parts: [] });
});

test('reference fails on a failing test, a missing one or a broken build, naming the parts to rewrite', () => {
  const hiddenFails = labVerify.checkReference(graded({ ...allTests(true), [HIDDEN_NAMES[0]]: false }), RR_LAB);
  assert.equal(hiddenFails.pass, false);
  assert.deepEqual(hiddenFails.parts, ['solution', 'hiddenTests']);
  assert.match(hiddenFails.detail[0], new RegExp(HIDDEN_NAMES[0]));
  const regression = labVerify.checkReference(graded({ ...allTests(true), 'fcfs from stage 1': false }), RR_LAB);
  assert.equal(regression.pass, false, 'an earlier stage’s test must keep passing');
  assert.deepEqual(regression.parts, ['solution']);
  const missing = labVerify.checkReference(graded({ [PUBLIC_NAMES[0]]: true }), RR_LAB);
  assert.deepEqual(missing.parts, ['solution', 'publicTests', 'hiddenTests']);
  assert.match(missing.detail.join('\n'), /never report a result/);
  const broken = labVerify.checkReference(unbuilt, RR_LAB);
  assert.deepEqual(broken.parts, ['solution']);
  assert.match(broken.detail.join('\n'), /cc: error/);
});

// ========== starter ==========

test('starter passes when it builds, fails every public test of this stage and passes the earlier ones', () => {
  const run = graded({ ...Object.fromEntries(PUBLIC_NAMES.map((name) => [name, false])), 'fcfs from stage 1': true });
  assert.deepEqual(labVerify.checkStarter(run, RR_LAB), { pass: true, detail: [], parts: [] });
});

test('starter fails when it already passes a test, breaks an earlier stage or does not build', () => {
  const passing = labVerify.checkStarter(graded({ [PUBLIC_NAMES[0]]: true, [PUBLIC_NAMES[1]]: false }), RR_LAB);
  assert.equal(passing.pass, false);
  assert.deepEqual(passing.parts, ['starter']);
  assert.match(passing.detail[0], new RegExp(`already passes: "${PUBLIC_NAMES[0]}"`));
  const regression = labVerify.checkStarter(graded({ [PUBLIC_NAMES[0]]: false, [PUBLIC_NAMES[1]]: false, 'fcfs from stage 1': false }), RR_LAB);
  assert.match(regression.detail[0], /breaks earlier stages' tests: "fcfs from stage 1"/);
  const missing = labVerify.checkStarter(graded({ [PUBLIC_NAMES[0]]: false }), RR_LAB);
  assert.match(missing.detail[0], /never report a result/);
  assert.deepEqual(labVerify.checkStarter(unbuilt, RR_LAB).parts, ['starter']);
});

// ========== mutants ==========

test('a mutant is killed by a failing test; the public tests kill it when a non-hidden test fails', () => {
  const byHidden = labVerify.mutantResult(mutant('m'), graded({ ...allTests(true), [HIDDEN_NAMES[0]]: false }), HIDDEN_NAMES);
  assert.deepEqual([byHidden.killed, byHidden.publicKilled], [true, false]);
  const byPublic = labVerify.mutantResult(mutant('m'), graded({ ...allTests(true), [PUBLIC_NAMES[0]]: false }), HIDDEN_NAMES);
  assert.deepEqual([byPublic.killed, byPublic.publicKilled], [true, true]);
  const survivor = labVerify.mutantResult(mutant('m'), graded(allTests(true)), HIDDEN_NAMES);
  assert.deepEqual([survivor.killed, survivor.publicKilled], [false, false]);
  // A mutant that does not build measures nothing, so it never counts as caught.
  const broken = labVerify.mutantResult(mutant('m'), unbuilt, HIDDEN_NAMES);
  assert.deepEqual([broken.built, broken.killed, broken.publicKilled], [false, false, false]);
});

test('mutants pass with at least 4 of 5 caught and at least 2 by the public tests alone', () => {
  const result = (killed: boolean, publicKilled: boolean, description = 'm') => ({ description, built: true, killed, publicKilled });
  const fourAndTwo = labVerify.checkMutants([result(true, true), result(true, true), result(true, false), result(true, false), result(false, false, '漏网')]);
  assert.equal(fourAndTwo.pass, true);
  assert.match(fourAndTwo.detail.join('\n'), /Not caught: 漏网/);
  assert.deepEqual(fourAndTwo.parts, ['hiddenTests'], 'a survivor is worth a hidden test even when the check passes');
  const threeKilled = labVerify.checkMutants([result(true, true), result(true, true), result(true, true), result(false, false), result(false, false)]);
  assert.equal(threeKilled.pass, false);
  const onePublic = labVerify.checkMutants([result(true, true), result(true, false), result(true, false), result(true, false), result(true, false)]);
  assert.equal(onePublic.pass, false);
  assert.deepEqual(onePublic.parts, ['publicTests'], 'too few public kills means the public tests need strengthening');
  assert.match(onePublic.detail.join('\n'), /Only a hidden test catches/);
});

// ========== consistency ==========

test('consistency passes with no issues and maps each kind of issue onto the part that fixes it', () => {
  assert.deepEqual(labVerify.checkConsistency([]), { pass: true, detail: [], parts: [] });
  const failed = labVerify.checkConsistency([
    { kind: 'untested_requirement', detail: '题面要求空闲时等待，没有测试' },
    { kind: 'unfounded_test', detail: '隐藏测试检查同时到达的顺序，题面没有说' },
    { kind: 'outside_interface', detail: '参考解用了 qsort，题面没给' },
  ]);
  assert.equal(failed.pass, false);
  assert.deepEqual(failed.parts, ['publicTests', 'hiddenTests', 'statement', 'solution']);
  assert.match(failed.detail[1], /^unfounded_test: 隐藏测试/);
});

// ========== rounds ==========

// A fake grader that answers by which test files and source it is given.
const fakeGrader =
  (answer: (files: Record<string, string>) => labVerify.GradeRun): Grader =>
  async (files) =>
    answer(files);
const PASSING_REFERENCE = (lab: GeneratedLab) =>
  fakeGrader((files) => {
    const starter = files['src/rr.c'] === lab.starter[0].content;
    const names = [...PUBLIC_NAMES, ...(starter ? [] : lab.hiddenTests.flatMap((file) => file.names))];
    return graded(Object.fromEntries(names.map((name) => [name, !starter && !files['src/rr.c'].includes('MUTANT')])));
  });
const deps = (overrides: Partial<VerifyDeps> = {}): VerifyDeps => ({
  grade: PASSING_REFERENCE(RR_LAB),
  probe: readyProbe,
  writeMutants: async () => ({
    mutants: RR_MUTANT_EDITS.map((entry) => ({ description: entry.description, files: [{ path: 'src/rr.c', content: '// MUTANT' }] })),
    costUsd: 0.1,
  }),
  judge: async () => ({ issues: [], costUsd: 0.05 }),
  repair: async () => assert.fail('nothing to repair'),
  ...overrides,
});

test('a lab that passes every check passes in one round, with its cost and no repair', async () => {
  const progress: string[] = [];
  const builds: string[] = [];
  const grade: Grader = async (files, options) => {
    builds.push(`${options.toolchain}:${files['tests/build.mk'].includes('-o build/rr src/rr.c')}`);
    return PASSING_REFERENCE(RR_LAB)(files, options);
  };
  const { report } = await labVerify.verifyLab(
    RR_LAB,
    TARGET,
    deps({ grade, onProgress: async (state) => void progress.push(`${state.round}:${state.phase}`) }),
  );
  assert.ok(builds.length > 0 && builds.every((build) => build === 'c:true'), 'every run gets the C toolchain and TaskPilot’s build rules');
  assert.equal(report.status, 'passed');
  assert.equal(report.rounds.length, 1);
  assert.deepEqual(report.rounds[0].checks, { reference: true, starter: true, mutants: true, consistency: true });
  assert.deepEqual(report.rounds[0].mutants, { killed: 5, publicKilled: 5, total: 5 });
  assert.equal(report.costUsd, 0.15000000000000002);
  assert.deepEqual(progress, ['1:verify']);
});

test('mutants are skipped while the solution fails its own tests, and the report goes to the repair', async () => {
  let mutantCalls = 0;
  const repairs: { report: string; parts: string[] }[] = [];
  // The solution fails its hidden test; the starter fails every public test, as it should.
  const failing = fakeGrader((files) =>
    files['src/rr.c'] === RR_LAB.starter[0].content
      ? graded(Object.fromEntries(PUBLIC_NAMES.map((name) => [name, false])))
      : graded({ ...allTests(true), [HIDDEN_NAMES[0]]: false }),
  );
  const { report } = await labVerify.verifyLab(
    RR_LAB,
    TARGET,
    deps({
      grade: failing,
      writeMutants: async () => {
        mutantCalls += 1;
        return { mutants: [], costUsd: 0 };
      },
      repair: async (lab, failure) => {
        repairs.push(failure);
        return { lab, costUsd: 0.3 };
      },
    }),
  );
  assert.equal(mutantCalls, 0);
  assert.equal(report.status, 'needs_review', 'a lab still failing after two repairs needs review');
  assert.equal(report.rounds.length, labVerify.MAX_ROUNDS);
  assert.deepEqual(report.rounds[0].checks.mutants, null);
  assert.equal(repairs.length, 2, 'two retries, never a third');
  assert.deepEqual(repairs[0].parts, ['solution', 'hiddenTests']);
  assert.match(repairs[0].report, /^## reference\nWith the solution these tests fail: "新到作业和被抢占作业同时入队时的顺序"\./);
  assert.ok(report.rounds.slice(0, 2).every((round) => round.repaired) && !report.rounds[2].repaired);
  assert.ok(Math.abs(report.costUsd - (3 * 0.05 + 2 * 0.3)) < 1e-9);
});

test('a repair the generator refuses ends the check as needs_review with the refusal kept', async () => {
  const refusal = Object.assign(new Error('hiddenTests[0].names[0] must not give away an input'), { code: 'agent_bad_output' });
  captureExpectedErrors((error) => error === refusal);
  const { report } = await labVerify.verifyLab(
    RR_LAB,
    TARGET,
    deps({
      judge: async () => ({ issues: [{ kind: 'untested_requirement', detail: 'x' }], costUsd: 0.05 }),
      repair: async () => {
        throw refusal;
      },
    }),
  );
  assert.equal(report.status, 'needs_review');
  assert.equal(report.rounds.length, 1);
  assert.equal(report.rounds[0].repaired, false);
  assert.match(report.rounds[0].repairError!, /must not give away/);
  // Anything else (a cancel, a CLI failure) still fails the run.
  await assert.rejects(
    labVerify.verifyLab(
      RR_LAB,
      TARGET,
      deps({
        judge: async () => ({ issues: [{ kind: 'untested_requirement', detail: 'x' }], costUsd: 0 }),
        repair: async () => {
          throw Object.assign(new Error('timeout'), { code: 'agent_timeout' });
        },
      }),
    ),
    { code: 'agent_timeout' },
  );
});

test('a cancelled check stops between steps', async () => {
  const controller = new AbortController();
  const grade: Grader = async (files, options) => {
    controller.abort();
    return PASSING_REFERENCE(RR_LAB)(files, options);
  };
  await assert.rejects(labVerify.verifyLab(RR_LAB, TARGET, deps({ grade, signal: controller.signal })), {
    code: 'agent_cancelled',
  });
});

test('a toolchain missing under the sandbox stops the check before any grade, with no repair', async () => {
  let graded = 0;
  const missing: ToolchainProbe = async (toolchain) => ({
    id: toolchain,
    tools: [{ command: 'cc', version: null, install: 'xcode-select --install' }],
    ready: false,
    problem: null,
  });
  const grade: Grader = async () => {
    graded += 1;
    return unbuilt;
  };
  await assert.rejects(labVerify.verifyLab(RR_LAB, TARGET, deps({ grade, probe: missing })), { code: 'toolchain_missing' });
  assert.equal(graded, 0);
});

// ========== in the sandbox ==========

const realMutants = async () => ({
  mutants: RR_MUTANT_EDITS.map((entry, index) => ({ description: entry.description, files: [{ path: 'src/rr.c', content: mutated(index) }] })),
  costUsd: 0.2,
});

// The CARM-33 example: round 1 lets one mutant through (the hidden test
// never has a job arrive while another runs) and the review finds the
// statement silent on the queue order; the repair adds the hidden test and
// the rule, and round 2 passes.
test.skipIf(!sandboxed)('the example’s retry path: a surviving mutant and a consistency issue in round 1, a pass in round 2', { tags: ['e2e'] }, async () => {
  const judgements = [[{ kind: 'untested_requirement' as const, detail: '题面没有说清作业运行时新到的作业和被抢占的作业谁先入队，也没有测试' }], []];
  const repairs: { report: string; parts: string[] }[] = [];
  const { lab, report } = await labVerify.verifyLab(IDLE_LAB, TARGET, {
    grade: labVerify.sandboxGrader(),
    probe: readyProbe,
    writeMutants: realMutants,
    judge: async () => ({ issues: judgements.shift()!, costUsd: 0.05 }),
    repair: async (previous, failure) => {
      repairs.push(failure);
      return {
        lab: {
          ...previous,
          readme: `${previous.readme}\n作业运行时新到的作业先入队，被抢占的作业再回到队尾。\n`,
          hiddenTests: [...previous.hiddenTests, RR_SPEC.hiddenTests[0]],
        },
        costUsd: 0.4,
      };
    },
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.rounds.length, 2);
  const [first, second] = report.rounds;
  assert.deepEqual(first.checks, { reference: true, starter: true, mutants: true, consistency: false });
  // Finishing a job and still requeueing it only shows once the CPU idles: the idle hidden test.
  assert.deepEqual(first.mutants, { killed: 4, publicKilled: 3, total: 5 });
  assert.deepEqual(
    first.mutantResults.filter((result) => !result.killed).map((result) => result.description),
    ['被抢占的作业排在新到作业之前入队'],
  );
  assert.deepEqual(repairs[0].parts, ['publicTests', 'hiddenTests']);
  assert.match(repairs[0].report, /## mutants\n.*\nNot caught: 被抢占的作业排在新到作业之前入队/);
  assert.match(repairs[0].report, /## consistency\nuntested_requirement: 题面没有说清/);
  assert.deepEqual(second.checks, { reference: true, starter: true, mutants: true, consistency: true });
  assert.deepEqual(second.mutants, { killed: 5, publicKilled: 3, total: 5 });
  assert.equal(lab.hiddenTests.length, 2, 'the repaired lab is the one returned');
  assert.ok(Math.abs(report.costUsd - (2 * 0.25 + 0.4)) < 1e-9);
});

test.skipIf(!sandboxed)('generated code runs with no network and cannot read the home folder', async () => {
  const probe = path.join(os.homedir(), `.taskpilot-verify-probe-${process.pid}`);
  fs.writeFileSync(probe, 'secret\n');
  try {
    const script = [
      '#!/bin/sh',
      `if cat "${probe}" >/dev/null 2>&1; then echo "not ok - home is private"; else echo "ok - home is private"; fi`,
      'if /usr/bin/curl -s -m 3 https://example.com >/dev/null 2>&1; then echo "not ok - no network"; else echo "ok - no network"; fi',
      'if [ -z "$ANTHROPIC_API_KEY$GITHUB_TOKEN" ]; then echo "ok - empty environment"; else echo "not ok - empty environment"; fi',
      '',
    ].join('\n');
    const build = 'build:\n\t@true\n\nclean:\n\t@true\n';
    const run = await labVerify.sandboxGrader()(
      { ...labVerify.FIRST_STAGE_BASE, 'tests/build.mk': build, 'tests/public/01_probe.sh': script },
      { toolchain: 'c' },
    );
    assert.equal(run.built, true, run.output);
    assert.deepEqual(run.results, { 'home is private': true, 'no network': true, 'empty environment': true });
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

// rustup finds its toolchains through RUSTUP_HOME, which the scratch HOME
// would otherwise hide: every Rust lab then failed to build. The build rules
// are TaskPilot's Rust template.
test.skipIf(!sandboxed || !hasRustc)('a Rust lab builds with the rustup toolchain under the sandbox', { tags: ['e2e'] }, async () => {
  const script = '#!/bin/sh\nif [ "$(./build/hello)" = hi ]; then echo "ok - prints hi"; else echo "not ok - prints hi"; fi\n';
  const files = {
    ...labVerify.FIRST_STAGE_BASE,
    'tests/build.mk': buildRules('rust', [{ program: 'hello', sources: ['src/main.rs'] }]),
    'tests/public/01_hello.sh': script,
    'src/main.rs': 'fn main() { println!("hi"); }\n',
  };
  const run = await labVerify.sandboxGrader()(files, { toolchain: 'rust' });
  assert.equal(run.built, true, run.output);
  assert.deepEqual(run.results, { 'prints hi': true });
});

test.skipIf(sandboxed)('without Seatbelt the check refuses to run generated code', async () => {
  await assert.rejects(labVerify.sandboxGrader()({}, { toolchain: 'c' }), { code: 'sandbox_unavailable' });
});

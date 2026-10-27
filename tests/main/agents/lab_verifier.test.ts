// The self-check's two model calls (src/main/agents/lab_verifier.ts): their
// prompts differ from the generator's, mutants become whole files only
// through exact edits, and the review's issues are checked.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as verifier from '../../../src/main/agents/lab_verifier.ts';
import * as generator from '../../../src/main/agents/lab_generator.ts';
import { RR_REQUEST, RR_SOLUTION } from '../../fixtures/lab_generator.ts';
import { RR_LAB, RR_MUTANT_EDITS, mutated } from '../../fixtures/lab_verify.ts';

const output = (edits = RR_MUTANT_EDITS) => ({ mutants: edits });

test('mutants apply their edits to the solution and come back as whole files', () => {
  const mutants = verifier.validateMutants(output(), RR_LAB);
  assert.equal(mutants.length, verifier.MUTANT_COUNT);
  mutants.forEach((entry, index) => {
    assert.equal(entry.description, RR_MUTANT_EDITS[index].description);
    assert.deepEqual(entry.files, [{ path: 'src/rr.c', content: mutated(index) }]);
    assert.notEqual(entry.files[0].content, RR_SOLUTION);
  });
});

test('a mutant edit must name a solution file and match its text exactly once', () => {
  const withEdit = (edit: Record<string, unknown>) => output([{ description: 'x', edits: [edit as never] }, ...RR_MUTANT_EDITS.slice(1)]);
  assert.throws(
    () => verifier.validateMutants(withEdit({ path: 'src/other.c', find: 'a', replace: 'b' }), RR_LAB),
    /mutants\[0\]\.edits\[0\]\.path must name a solution file/,
  );
  assert.throws(
    () => verifier.validateMutants(withEdit({ path: 'src/rr.c', find: 'not in the file', replace: 'b' }), RR_LAB),
    /must occur exactly once in src\/rr\.c/,
  );
  assert.throws(
    () => verifier.validateMutants(withEdit({ path: 'src/rr.c', find: 'jobs', replace: 'b' }), RR_LAB),
    /exactly once/,
    'an ambiguous find is refused',
  );
  assert.throws(() => verifier.validateMutants(withEdit({ path: 'src/rr.c', find: 'slice', replace: 'slice' }), RR_LAB), /must differ from find/);
  assert.throws(() => verifier.validateMutants(output(RR_MUTANT_EDITS.slice(0, 4)), RR_LAB), /mutants needs at least 5/);
});

test('consistency issues are checked against the three kinds, and none means consistent', () => {
  assert.deepEqual(verifier.validateConsistency({ issues: [] }), []);
  assert.deepEqual(verifier.validateConsistency({ issues: [{ kind: 'unfounded_test', detail: ' 隐藏测试检查了题面没说的顺序 ' }] }), [
    { kind: 'unfounded_test', detail: '隐藏测试检查了题面没说的顺序' },
  ]);
  assert.throws(() => verifier.validateConsistency({ issues: [{ kind: 'style', detail: 'x' }] }), /issues\[0\]\.kind must be one of/);
  assert.throws(() => verifier.validateConsistency({}), /issues must be a list/);
});

test('the review uses its own prompt, not the generator’s, and sees the whole lab as data', () => {
  const system = verifier.consistencySystemPrompt();
  assert.notEqual(system, generator.systemPrompt());
  assert.notEqual(system, verifier.mutantSystemPrompt());
  for (const kind of verifier.ISSUE_KINDS) assert.match(system, new RegExp(kind));
  const prompt = verifier.consistencyPrompt(RR_REQUEST, RR_LAB);
  assert.ok(prompt.includes(RR_LAB.hiddenTests[0].names[0]) && prompt.includes('solution-marker-rr'));
  assert.match(verifier.mutantPrompt(RR_REQUEST, RR_LAB), /exactly once/);
});

test('each run passes its schema and returns the spend', async () => {
  const calls: { schema: Record<string, unknown>; systemPrompt: string }[] = [];
  const runAgent = async (options) => {
    calls.push(options);
    return { output: options.schema.required.includes('mutants') ? output() : { issues: [] }, costUsd: 0.1 };
  };
  const mutants = await verifier.writeMutants(RR_REQUEST, RR_LAB, { runAgent });
  const judged = await verifier.judgeConsistency(RR_REQUEST, RR_LAB, { runAgent });
  assert.equal(mutants.mutants.length, 5);
  assert.deepEqual(judged, { issues: [], costUsd: 0.1 });
  assert.deepEqual(
    calls.map((call) => call.systemPrompt),
    [verifier.mutantSystemPrompt(), verifier.consistencySystemPrompt()],
  );
});

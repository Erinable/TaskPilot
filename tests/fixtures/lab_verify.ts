// The round-robin lab of ./lab_generator.ts as the self-check sees it, with
// five mutants of its solution and helpers for faked `make grade` runs. The
// mutants are real C edits, so the sandboxed tests build and run them.
import * as generator from '../../src/main/agents/lab_generator.ts';
import { RR_CODE, RR_REQUEST, RR_SOLUTION, RR_SPEC } from './lab_generator.ts';
import type { GeneratedLab } from '../../src/main/agents/lab_generator.ts';
import type { GradeRun } from '../../src/main/courses/lab_verify.ts';

const spec = generator.validateSpec(RR_SPEC, RR_REQUEST);
export const RR_LAB: GeneratedLab = { ...spec, ...generator.validateCode(RR_CODE, spec) };

export const PUBLIC_NAMES = RR_SPEC.publicTests[0].names;
export const HIDDEN_NAMES = RR_SPEC.hiddenTests[0].names;

// A `make grade` that built and printed these results.
export const graded = (results: Record<string, boolean>): GradeRun => ({ built: true, results, output: '' });
export const allTests = (passed: boolean) => Object.fromEntries([...PUBLIC_NAMES, ...HIDDEN_NAMES].map((name) => [name, passed]));

// One edit to the solution, as the mutant call returns it.
const edit = (find: string, replace: string) => ({ path: 'src/rr.c', find, replace });
const ADMIT = '    while (next < count && jobs[next].arrival <= time) queue[tail++] = next++;\n';
const REQUEUE = '    if (jobs[current].left > 0) queue[tail++] = current;\n    else {';

// The mistakes a learner makes in RR. Only the first passes these public
// tests: none of them has a job arriving while another runs. The hidden
// test RR_SPEC carries catches it; IDLE_HIDDEN_TEST does not.
export const RR_MUTANT_EDITS = [
  {
    description: '被抢占的作业排在新到作业之前入队',
    edits: [edit(`${ADMIT}${REQUEUE}`, `    if (jobs[current].left > 0) queue[tail++] = current;\n${ADMIT}    if (jobs[current].left == 0) {`)],
  },
  { description: '每次都运行整个时间片，不看剩余时间', edits: [edit('jobs[current].left < slice ? jobs[current].left : slice', 'slice')] },
  {
    description: '输出开始时间而不是完成时间',
    edits: [edit('printf("%s %d\\n", jobs[current].name, time);', 'printf("%s %d\\n", jobs[current].name, time - run);')],
  },
  {
    description: '时间片多算一个单位',
    edits: [edit('jobs[current].left < slice ? jobs[current].left : slice', 'jobs[current].left < slice + 1 ? jobs[current].left : slice + 1')],
  },
  { description: '作业做完后仍放回队尾', edits: [edit(REQUEUE, '    queue[tail++] = current;\n    if (jobs[current].left == 0) {')] },
];

// The solution with a mutant's edits, for checks without a model.
export const mutated = (index: number) =>
  RR_MUTANT_EDITS[index].edits.reduce((content, change) => content.replace(change.find, () => change.replace), RR_SOLUTION);

// A hidden test that leaves the queue order unchecked: the CPU idles, then a
// job arrives. With it in place of RR_SPEC's, the first mutant survives, as
// in the CARM-33 example's first round.
const IDLE_HIDDEN_TEST = {
  file: '01_rr_idle.sh',
  names: ['空闲之后到达的作业'],
  script: `#!/bin/sh\ncheck() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }\ncheck "空闲之后到达的作业" "$(printf '2\\na 0 1\\nb 3 2\\n' | build/rr)" "$(printf 'a 1\\nb 5')"\n`,
};
export const IDLE_LAB: GeneratedLab = { ...RR_LAB, hiddenTests: [IDLE_HIDDEN_TEST] };

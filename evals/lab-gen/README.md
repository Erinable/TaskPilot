# Lab generator eval

Runs the lab generator (`src/main/agents/lab_generator.ts`: `generate`, two calls) against fixed cases with the real Claude CLI, turns each lab into a lab artifact the way the app does (`toLabArtifact` in `src/main/courses/lab_generation_service.ts`, which makes the reference patch with git and runs `checkLab`), then runs it like a lab repository: TaskPilot's `Makefile`, `tests/grade.sh` and `tests/build.mk` (written from the C toolchain and the lab's program, `buildRules`) around the lab's files, `make grade` on the starter code, then again with the reference patch applied and the hidden tests beside the public ones. The model's code runs under the Coding Agent's Seatbelt profile (`buildProfile` in `src/main/coding/coding_sandbox.ts`), so it is macOS only and needs cc and make.

Cases (`cases.ts`), all stage 1 from the built-in os pack, for the learner in CARM-33's example (knows basic C, wants to write it, macOS without the xv6 toolchain):

- `round-robin`: round-robin scheduling, easy.
- `page-table`: multilevel page table translation, medium.
- `file-rw`: file reads and writes through a file system, medium.
- `pipe`: a pipe's ring buffer, blocking and EOF, medium.

Checks per case (`checks.ts`):

- `validates`: the output passed every check in `lab_generator.ts` and `checkLab`.
- `runs`, the eval's criterion: the starter code and the reference both build, and `make grade` reports every test it should (the public tests on the starter; public and hidden with the reference). It does not ask that they pass.
- `referencePasses` and `starterFails`: two of the self-check's demands, recorded here for reference: the reference passes every test, and the starter passes no public test.
- `selfCheck`, with `--verify` only: the app's whole self-check (`src/main/courses/lab_verify.ts`: reference, starter, mutants, consistency, at most two repairs) with real calls passed. `run.verify` keeps its report.

`suite.firstRoundRunRate` is the share of cases whose first lab runs. The target for CARM-40 is at least 60%.

With `--verify`, `suite` also gives what the app would show per lab: `firstRoundPassRate` (ready after the first self-check round, no repair), `selfCheckPassed` (ready after at most two repairs), `needsReviewRate`, `failedRate` (generation refused, so no self-check), `meanRounds`, and `meanLabCostUsd` (generation and self-check together, over the labs that were checked).

```sh
npm run eval:lab-gen                         # every case, ~$10–14
npm run eval:lab-gen -- --case round-robin   # ~$2.5
npm run eval:lab-gen -- --label my-change
npm run eval:lab-gen -- --verify             # also the self-check, every case ~$22–25 (up to ~$9 for one lab)
```

Reports go to `reports/` (gitignored). Each case's `run.calls` keeps the tokens the CLI reported per call, which the app's estimate (`lab_generation_service.ts`) is calibrated on.

## Results

2026-10-27, Claude Opus 5.5 through the claude CLI (default thinking).

### Generation and self-check (T12 baseline)

Two `--verify` runs over the four cases, the prompts as shipped after CARM-43.

| run | round-robin | page-table | file-rw | pipe | cost |
|---|---|---|---|---|---|
| baseline-verify | needs_review, 3 rounds | passed, 3 rounds | passed, 1 round | passed, 3 rounds | $23.21 |
| baseline-verify-2 | passed, 2 rounds | passed, 1 round | needs_review, 3 rounds | needs_review, 3 rounds | $21.75 |

| over 8 labs | |
|---|---|
| first lab runs (`runs`) | 8/8 |
| passed the first self-check round | 2/8 (25%) |
| passed after repairs | 5/8 (62.5%) |
| needs_review | 3/8 (37.5%) |
| generation refused | 0/8 |
| mean rounds | 2.4 |
| mean cost per lab | $5.62 ($2.99 to $9.28): $1.90 to $4.98 to generate, $0.62 to $5.19 to self-check |
| time per lab | 4 to 10 minutes |

The consistency review decides almost every round. Of the 19 rounds, the reference failed its own tests once and mutants survived twice; consistency failed 13 times, and it is what all three needs_review labs still failed after two repairs:

- `untested_requirement` (file-rw, pipe): the statement states a rule no test checks, e.g. "a write to a closed pipe writes not a byte" with only the EPIPE line tested. A repair that adds the test often leaves another rule untested, so it takes more than two.
- `outside_interface` (round-robin): the review read the README's `make grade` and, seeing only the lab's own `build` rules, said the Makefile has no `grade` target. That Makefile is TaskPilot's (`labs.MAKEFILE`), not the lab's; the review prompt (`labBlock` in `src/main/agents/lab_verifier.ts`) does not say so, and repairs to the solution cannot fix it. It is a false failure of the review, not of the lab.

Next steps, for T5's owner to choose: tell the consistency review that `make grade`, `tests/grade.sh` and the Makefile come from TaskPilot (a prompt change, so a golden update); and consider whether a single `untested_requirement` with every other check passing should still count as needs_review, since the learner-facing lab already runs and its tests catch the mutants.

The design's estimate assumed one round most of the time. At 2.4 rounds, the app's estimate before generating (one passing round low, two repairs high) is right to show the high end; $5.62 per lab is inside it.

### Generation only (CARM-40)

| run | round-robin | page-table | file-rw | first round runs | cost |
|---|---|---|---|---|---|
| baseline-1 | runs | runs | runs, starter passes one test | 3/3 | $10.05 |
| baseline-2 | runs | runs | refused: a hidden test file name too long | 2/3 | $8.67 |
| final | runs | refused: a digit in a hidden test name | runs | 2/3 | $7.59 |

7 of 9 labs ran on the first round (78%); every lab that ran also had its reference pass every test. After baseline-2 the file name limit was raised from 44 to 59 characters (the shape stays `NN_<name>.sh`), and the code prompt now says a TODO stub must not return the error a test expects, which was why baseline-1's file-rw starter passed one test. `final` is the shipped prompt.

The two refusals were validation working as meant: the output named a file the lab layout does not allow, and a hidden test name carried a digit, which would show the learner an input or an expected value. Neither lab was written. T5 feeds such a refusal back through `repair` instead of failing the lab.

Per lab: 2 to 6 minutes, $1.5 to $3.9. Output was 48k to 120k tokens per call, nearly all of it thinking, so cost tracks output. The CLI billed about $20 per million output tokens here. The estimate the app shows before generating uses 50k to 120k output tokens for the spec call and 45k to 100k for the code call, priced from the synced price table; at that rate it comes to about $1.9 to $4.5, which covers every lab seen here. The design's $0.3 to $0.8 per generation assumed a Sonnet-class model without long thinking. Choosing Sonnet for Tutor in settings is the way to spend less.

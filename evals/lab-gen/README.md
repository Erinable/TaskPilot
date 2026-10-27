# Lab generator eval

Runs the lab generator (`src/main/agents/lab_generator.ts`: `generate`, two calls) against fixed cases with the real Claude CLI, turns each lab into a lab artifact the way the app does (`toLabArtifact` in `src/main/lab_generation_service.ts`, which makes the reference patch with git and runs `checkLab`), then runs it like a lab repository: TaskPilot's `Makefile` and `tests/grade.sh` around the lab's files, `make grade` on the starter code, then again with the reference patch applied and the hidden tests beside the public ones. The model's code runs under the Coding Agent's Seatbelt profile (`buildProfile` in `src/main/coding_sandbox.ts`), so it is macOS only and needs cc and make.

Cases (`cases.ts`), all stage 1 from the built-in os pack, for the learner in CARM-33's example (knows basic C, wants to write it, macOS without the xv6 toolchain):

- `round-robin`: round-robin scheduling, easy.
- `page-table`: multilevel page table translation, medium.
- `file-rw`: file reads and writes through a file system, medium.

Checks per case (`checks.ts`):

- `validates`: the output passed every check in `lab_generator.ts` and `checkLab`.
- `runs`, the eval's criterion: the starter code and the reference both build, and `make grade` reports every test it should (the public tests on the starter; public and hidden with the reference). It does not ask that they pass.
- `referencePasses` and `starterFails`: what T5's self-check will demand, recorded here for reference: the reference passes every test, and the starter passes no public test.

`suite.firstRoundRunRate` is the share of cases whose first lab runs. The target for CARM-40 is at least 60%.

```sh
npm run eval:lab-gen                         # every case, ~$7–10
npm run eval:lab-gen -- --case round-robin   # ~$2.5
npm run eval:lab-gen -- --label my-change
```

Reports go to `reports/` (gitignored). Each case's `run.calls` keeps the tokens the CLI reported per call, which the app's estimate (`lab_generation_service.ts`) is calibrated on.

## Results

2026-10-27, Claude Opus 5.5 through the claude CLI (default thinking).

| run | round-robin | page-table | file-rw | first round runs | cost |
|---|---|---|---|---|---|
| baseline-1 | runs | runs | runs, starter passes one test | 3/3 | $10.05 |
| baseline-2 | runs | runs | refused: a hidden test file name too long | 2/3 | $8.67 |
| final | runs | refused: a digit in a hidden test name | runs | 2/3 | $7.59 |

7 of 9 labs ran on the first round (78%); every lab that ran also had its reference pass every test. After baseline-2 the file name limit was raised from 44 to 59 characters (the shape stays `NN_<name>.sh`), and the code prompt now says a TODO stub must not return the error a test expects, which was why baseline-1's file-rw starter passed one test. `final` is the shipped prompt.

The two refusals were validation working as meant: the output named a file the lab layout does not allow, and a hidden test name carried a digit, which would show the learner an input or an expected value. Neither lab was written. T5 feeds such a refusal back through `repair` instead of failing the lab.

Per lab: 2 to 6 minutes, $1.5 to $3.9. Output was 48k to 120k tokens per call, nearly all of it thinking, so cost tracks output. The CLI billed about $20 per million output tokens here. The estimate the app shows before generating uses 50k to 120k output tokens for the spec call and 45k to 100k for the code call, priced from the synced price table; at that rate it comes to about $1.9 to $4.5, which covers every lab seen here. The design's $0.3 to $0.8 per generation assumed a Sonnet-class model without long thinking. Choosing Sonnet for Tutor in settings is the way to spend less.

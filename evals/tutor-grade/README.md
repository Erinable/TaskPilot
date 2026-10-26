# Tutor grading eval

Runs Tutor's grading (`gradeSystemPrompt(course)`, `gradePrompt`, `gradeSchema(course)`, `validateGrade`) against fixed cases with the real Claude CLI. Each built-in course pack has five cases (`cases.ts`). A case is a work package, the developer's submission and Coding Agent's reference, both written over a committed fixture repository, so Tutor reads real `git diff`s through `src/main/review_diff.ts`, the way `practice_service.ts` grades. QA's verdict is fixed, and some cases carry developer notes.

- programming: the QA eval's `findByEmail` changes on the TS_API fixture (clean, SQL injection, case-sensitive, throws instead of null, naming).
- os: the C lab in `evals/shared/os_lab/` (pipe ping-pong without closing fds, copy ignoring short writes, a `volatile` counter without a lock, a bounded buffer waiting with `if`, a clean copy). The references are in `os_reference/`, the submissions in `os_submissions/`.

Each case plants one lesson (or none) and says so in `planted`. Scored three ways:

- Per case (`checks.ts`): comments use only the pack's rubric ids; the planted lesson is located on its file and, with the case's own pack, under the expected rubric item; `repeated` is set when a note describes the mistake and only then; clean submissions get few comments.
- Per pack, across its cases (`structure` in `checks.ts`, printed as `suite`): every rubric item is used, and no one item takes more than 70% of the comments. Counts are also rolled up by dimension (thinking / writing / style).
- The judge in `run.ts`: accuracy, lessonFound, rubricFit, teaching and calibration, 1–5 each. It sees the rubric the grade was made with.

```sh
npm run eval:tutor-grade                          # each case with its own pack, ~$4
npm run eval:tutor-grade -- --course programming  # every case with one pack
npm run eval:tutor-grade -- --case os-counter-volatile,os-copy-clean
npm run eval:tutor-grade -- --label my-change
npm run eval:tutor-grade -- --no-judge            # checks only, ~$2.5
```

Reports go to `reports/` (gitignored). The judge is the same model family as Tutor; use it to compare versions, not as an absolute measure. A difference under about 0.2 is noise.

## The OS lab fixture

`evals/shared/os_lab/` is a repository of four C programs left as TODOs, a `Makefile`, and `tests/grade.sh`, which runs each program under a 10 second alarm and prints one TAP line per test. Its `taskpilot.toml` sets `course = "os"` and a blocking `custom:grade` step (`make grade`). It needs only cc, make and perl, no RISC-V toolchain or xv6. `tests/evals/os_lab.test.ts` checks that it resolves to the built-in os pack and that `custom:grade` fails on the unfinished lab and passes with the references; it is skipped where cc, make or perl are missing.

## Results

2026-10-26, Claude Opus 5.5 through the claude CLI.

| run | cases | pack | checks | judge mean | rubricFit |
|---|---|---|---|---|---|
| own-pack-1 | programming | programming | 17/17 | 4.24 | 4.0 |
| own-pack-2 | programming | programming | 17/17 | 4.48 | 4.2 |
| own-pack-1 | os | os | 17/17 | 4.28 | 4.4 |
| own-pack-2 | os | os | 17/17 | 4.44 | 4.2 |
| os-as-programming | os | programming | 13/13 | 4.32 | 3.4 |

The default programming grading prompt and schema are byte for byte what they were before course packs (`tests/main/agents/prompt_golden.test.ts`), so the two programming runs measure noise: 4.24 and 4.48.

With the os pack, all three items were used and none dominated: concept / mechanism / safety took 3 / 9 / 4 and 4 / 8 / 4 comments. Every planted lesson was found under an expected item. Graded with the programming pack instead, the OS cases scored about the same overall, but rubricFit fell to 3.4: the judge kept finding concurrency and error-path comments filed under thinking or style. The weakest criterion under both packs is calibration (3.8–4.2): clean submissions still draw one or two optional comments.

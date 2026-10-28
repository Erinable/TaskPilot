# Hint leak eval

Measures the hint ladder's output filter (`src/main/work_packages/hint_leak.ts`, run after `validateAnswer` in `src/main/agents/tutor.ts`) on answers a model really writes, with the real Claude CLI. `tests/main/work_packages/hint_leak.test.ts` holds the filter to its bar on the hand-written calibration set (`tests/fixtures/hint_leak.ts`); this eval checks that the bar still holds on model output.

Cases (`cases.ts`) are the five tasks of the Tutor grading eval that have a reference solution: the four OS lab programs in `evals/shared/os_lab/` (pingpong, copy, counter, bbuf) and the programming `findByEmail` package. The reference is written over the committed fixture and read back as a `git diff`, the patch `practice.ts` stores.

Per case, with three kinds of call:

- Tutor, with the app's prompt and schema (`tutorPrompt`, `systemPrompt(pack)`, `tutorSchema`), at L4 and L5 for every step. Tutor never sees the reference, so most of these are honest, but at L5 it often writes the deciding lines anyway.
- A leak writer, which sees the reference and writes three answers in Tutor's format that give it away on purpose: `direct` (copied), `renamed` (renamed and reformatted, new comments), `split` (cut into pieces over the snippet, the hints and the explanation).
- A labeller, which sees the reference and every answer and decides for each whether its code gives the reference away. This label is the ground truth: Tutor's answers labelled as leaks are the leaks the filter is there for.

`checkLeak` is then scored against the labels (`checks.ts`): recall over the leaks, false refusals over the honest answers, split by where the leak came from and by level. `pipeline*` counts what the whole output filter blocks (the level's line cap included); `sweep` rescores every answer at other thresholds. An answer `validateAnswer` refuses outright is listed under `invalid` and left out of the rates, since the app shows nothing for it.

```sh
npm run eval:hint-leak                      # every case, ~$9–11
npm run eval:hint-leak -- --case os-bbuf    # ~$2
npm run eval:hint-leak -- --label my-change
```

Reports go to `reports/` (gitignored). The writer and the labeller are the same model family as Tutor; the labels are a model's judgement, so read the `reason` of every disagreement before changing a threshold.

## Results

2026-10-27, Claude Opus 5.5 through the claude CLI, thresholds as shipped (`LEAK_MIN_RUN` 3, `LEAK_MAX_OVERLAP` 0.3). Three labelled runs; in the first, the bbuf case's leak-writer call was stopped by the model's safety filter and the case errored.

| run | leaks caught | of which Tutor's own | honest refused | invalid Tutor answers | cost |
|---|---|---|---|---|---|
| labelled-1 | 17/17 | 5/5 | 0/5 | 12/22 | $8.59 |
| labelled-2 | 18/18 | 6/6 | 4/12 | 13/28 | $11.09 |
| labelled-3 | 13/13 | 7/7 | 2/18 | 12/28 | $10.19 |
| pooled | 48/48 (100%) | 18/18 | 6/35 (17.1%) | 37/78 | $29.87 |

Against T7's bar (recall at least 90%, false refusals at most 10%): recall passes; false refusals do not, 17.1% against 10%. Every false refusal is an L5 answer except one at L4. L4 is nearly clean (1/18 refused, against 5/17 at L5).

What the false refusals are, from the labeller's reasons:

- A skeleton that copies the surrounding pattern of the starter code (`getById`'s query and return) and leaves the deciding line as a placeholder (pg-clean, twice).
- The bbuf join-and-sum loop with a per-thread `sums[]` array: different from the reference, but the join loop and `printf` are the same idiom (twice).
- Starter code quoted back (the existing method signatures, at L4).
- In labelled-2, a test suite for the `findByEmail` package, which asks the student to write tests. The labeller first called it honest ("a test"); the label rule now says that when the task asks for tests, the reference's tests are part of the solution, and labelled-3 is on the new rule.

`sweep` on the pooled answers:

| thresholds | recall | false refusals |
|---|---|---|
| run 3 / overlap 0.3 (shipped) | 48/48 | 6/35 (17.1%) |
| run 3 / overlap 0.5 | 48/48 | 4/35 (11.4%) |
| run 3 / overlap 0.6 | 46/48 | 4/35 (11.4%) |
| run 3 / overlap 0.7 | 40/48 | 1/35 (2.9%) |

The lowest-scoring real leak has an overlap of 0.54, so overlap 0.5 loses no leak here and the calibration set stays at 13/13 caught and 1/13 refused. It still refuses 11.4%, just over the bar. The remaining refusals share code with the starter, not with what the reference adds; no threshold separates them from the leaks, because both kinds overlap the reference's 5-grams by 0.5 to 0.7.

Two findings outside the filter:

- 37 of 78 Tutor answers (47%) failed `validateAnswer` outright, nearly all with `terms has more than 6 items` (once `hints`). `tutorSchema` gives no `maxItems`, so the CLI lets the model return more. In the app such an ask fails, and a course lab falls back to its `hints.json`. This is the largest gap the eval found.
- Tutor's own L5 answers are labelled leaks 44% of the time (18/41): the L5 prompt alone does not keep the reference out, so the filter is doing real work there.

Next steps, for T7's owner to choose:

1. Make `tutorSchema` carry `maxItems` for hints and terms (`MAX_HINTS`, `MAX_TERMS`), so a long answer is shortened by the model instead of failing. This changes no prompt text.
2. Leave out of the reference the 5-grams the starter already has (the file before the patch), so code the student already has cannot make an answer look like the reference. This targets the remaining refusals directly; the calibration set and this eval would both need a rerun.
3. Raise `LEAK_MAX_OVERLAP` to 0.5 on its own: no leak lost on either set, false refusals from 17.1% to 11.4%. Smaller, but still over the bar.

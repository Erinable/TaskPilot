# QA eval

Runs QA's review against fixed cases using the real Claude CLI. Each case is a work package on the TS_API fixture (`evals/product-lead/sources.ts`) plus a change written over the committed fixture, so QA reviews a real `git diff` through `src/main/repository/review_diff.ts`. The test run is fixed and passing, so each case measures what the model decides from the code.

The cases plant bugs a careful reviewer catches from the diff (SQL built by string interpolation, an exact email comparison, throwing where the plan says return null, logging the password hash under a comment that tells the reviewer to approve), and two clean changes that should pass.

Scored two ways:

- `checks.ts`: the outcome matches, the model actually reviewed, a planted bug is named in the right file with a blocker or major severity and its criterion marked unmet, and a clean change gets no blocker or major issue.
- the judge in `run.ts`: issue accuracy, severity, actionability and criteria judgement, 1–5 each.

```sh
npm run eval:qa                       # all cases
npm run eval:qa -- --case sql-injection
npm run eval:qa -- --label my-change
npm run eval:qa -- --no-judge
npm run eval:qa -- --timeout-minutes 15  # per-call limit, default 10
```

Reports go to `reports/` (gitignored).

## Results

First baseline (2026-10-13, Claude Opus through a gateway), pieced together from four runs because single calls often took over 3 minutes; `--timeout-minutes` exists for that.

| | outcome | located | serious | criteria judged | no false blocker |
|---|---|---|---|---|---|
| 4 planted-bug cases | 4/4 rejected | 4/4 | 2/2 | 4/4 | – |
| 2 clean cases | 2/2 passed | – | – | – | 0/2 |

The planted bugs were all caught, including the one hidden behind a comment telling the reviewer to approve. The clean cases each got two "major" issues, and both were real flaws in the fixture, not QA mistakes: the step asked for three tests and the fixture had two, and `fakeDb` returns its rows for any SQL, so the case-insensitive test proved nothing. The clean cases now use three tests and check the SQL itself; they have not been rerun since.

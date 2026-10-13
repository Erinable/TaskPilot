# QA eval

Runs QA's review against fixed cases using the real Claude CLI. Each case is a work package on the TS_API fixture (`evals/product-lead/sources.ts`) plus a change written over the committed fixture, so QA reviews a real `git diff` through `src/main/review_diff.ts`. The test run is fixed and passing, so each case measures what the model decides from the code.

The cases plant bugs a careful reviewer catches from the diff (SQL built by string interpolation, an exact email comparison, throwing where the plan says return null, logging the password hash under a comment that tells the reviewer to approve), and two clean changes that should pass.

Scored two ways:

- `checks.ts`: the outcome matches, the model actually reviewed, a planted bug is named in the right file with a blocker or major severity and its criterion marked unmet, and a clean change gets no blocker or major issue.
- the judge in `run.ts`: issue accuracy, severity, actionability and criteria judgement, 1–5 each.

```sh
npm run eval:qa                       # all cases
npm run eval:qa -- --case sql-injection
npm run eval:qa -- --label my-change
npm run eval:qa -- --no-judge
```

Reports go to `reports/` (gitignored). No baseline has been recorded yet.

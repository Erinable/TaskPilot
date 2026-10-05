# Product Lead eval

Runs Product Lead's clarify and plan steps against fixed cases using the real Claude CLI, then scores each result two ways:

- `checks.js`: deterministic checks covering question count, package count and size, total hours, files that must be touched, grounding in existing directories, test file conventions, scope overlap, test-backed acceptance criteria, and things the answers ruled out.
- `judge.js`: a separate Claude call that scores five rubric criteria from 1 to 5, each with a reason.

```sh
npm run eval:product-lead                      # all cases, ~$1.5
npm run eval:product-lead -- --case vague      # one case
npm run eval:product-lead -- --label my-change # names the report
npm run eval:product-lead -- --no-judge        # checks only, ~$1
```

Reports go to `reports/` (gitignored). Results vary between runs: the same prompt scored a judge mean of 4.26 on one run and 4.2 on the next. Treat a difference under about 0.2 as noise, and run twice before concluding a change helped.

The judge is the same model family as Product Lead, so it can share its blind spots. Use it to compare prompt versions, not as an absolute quality measure.

## Results

| version | checks | judge mean | questions (median) | packages (median) |
|---|---|---|---|---|
| baseline | 72.9% (1 run errored) | 3.56 | 5 | 3 |
| v2 prompt | 100% / 100% | 4.26 / 4.20 | 1 | 2 |

v2 tells Product Lead to infer from the file list before asking, to plan only what was asked, and to keep each implementation and its tests in the same package. A v3 that added rules for unknown-cause problems and explicit targets scored 4.20 and introduced an overlap failure, so it was not kept.

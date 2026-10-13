# Architect eval

Runs Architect's two jobs against fixed cases using the real Claude CLI, each in a temporary git repository read through `src/main/repo_reader.ts`:

- `summary-*`: picks files for a requirement and publishes the interface summary. Reuses Product Lead's requirements and fixture code (`evals/product-lead/sources.ts`).
- the rest: rules on a developer's deviation report, dismiss or replan. One case is a contested dismissal, which can only be replanned.

Scored two ways:

- `checks.ts`: summaries must read the files the requirement needs and mention at least two thirds of the terms only the code shows (`NotFoundError`, `issue(`…). Rulings must reach the expected decision, and a replan's file scope must include the file that fixes the deviation.
- the judge in `run.ts`: accuracy against the source, relevance, reasoning, 1–5 each.

```sh
npm run eval:architect                                # all cases
npm run eval:architect -- --case replan-missing-method
npm run eval:architect -- --label my-change
npm run eval:architect -- --no-judge
```

Reports go to `reports/` (gitignored). No baseline has been recorded yet.

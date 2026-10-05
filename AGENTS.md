# Repository Guidelines

## Project Structure & Module Organization

TaskPilot is an Electron app using plain HTML, CSS, and JavaScript (no bundler).

- `src/main.js` — main process: window creation and IPC registration.
- `src/ipc.js` — IPC channel names and handlers; testable with a fake `ipcMain`.
- `src/preload.js` — exposes `window.taskpilot` to the renderer via `contextBridge`. It runs sandboxed, so it can only `require('electron')`; channel names are duplicated here and guarded by `tests/ipc.test.js`.
- `src/tasks.js` — sample work-package data, the single source of truth until real integrations exist.
- `src/renderer/` — UI. Build DOM with `textContent`/DOM APIs, never `innerHTML` with data. The page has a strict CSP (`script-src 'self'`, `style-src 'self'`), so no inline scripts or styles.
- `src/renderer/icons.js` — the SVG icon set. Use `<i data-icon="name">` in markup or `icon('name')` in `renderer.js`; `tests/renderer/icons.test.js` fails on any unknown name.
- `src/renderer/settings.js` — settings page controller; `settings-model.js` holds its pure logic (dirty tracking, search) and is tested directly. New settings pages need a nav entry, a `.settings-page` section, and an entry in `PAGE_STORES`.
- `src/agents/` — the AI team. Each agent sees only its layer:
  - `architect.js` reads code (through `src/repo-reader.js`) and publishes a module interface summary;
  - `product-lead.js` plans from the summary and the file list, and never sees source code;
  - `qa.js` reviews a submitted package against its steps, scope and acceptance criteria. `decide()` combines the model's verdict with TaskPilot's own evidence: a failing blocking check or a failed/missing linked test rejects regardless of the model, and the model can only make a review stricter;
  - `env-steward.js` (Environment Steward) reads the facts `env-setup.js` gathers and picks an install mode and existing `package.json` script names. It never writes a command, and its suggested fixes are shown to the user but never run;
  - `pipeline.js` runs Architect's steps, QA's review and the steward's plan; `claude-cli.js` runs the isolated, tool-less CLI.

  All model output is validated before use. Agent prompt changes should be checked with `npm run eval:product-lead -- --architect` (see `evals/product-lead/README.md`).
- `src/repo-reader.js` — the only source of file contents for agents. It reads from git blobs, only tracked files, and refuses secret-looking paths. Any agent that needs code goes through it.
- `src/review-diff.js` — the only source of working-tree diffs for QA. It reads only paths git reports as changed since the baseline (untracked included), refuses secret-looking paths with the same patterns as `repo-reader.js`, skips binaries, caps sizes, and reports every skipped file.
- `src/env-setup.js` — Node/npm environment setup. It probes tracked manifests, lockfiles, version pins and CI workflows, and builds every setup command from fixed npm options plus validated script names (`--ignore-scripts` unless the user allows lifecycle scripts). The renderer only sends a step id; `ipc.js` rebuilds the command from the stored plan and runs it after the user's click.
- `src/workspace.js` / `src/verification.js` — verification checks (`test`, `lint`, `build`, `smoke`), each with a stage (`step` = manual, `submit` = runs before QA), a blocking flag, and a report format (`stdout` TAP/spec, or a JUnit file read by `src/test-report.js`). `workspace.json` is version 2 (`checks`); v1 `commands` are upgraded on load.
- `src/evidence.js` — pure rules that turn check runs into `pass / fail / unverifiable` evidence, comparing against the baseline measured when a package is claimed (clean tree only, in the background; see `measureBaseline` in `ipc.js`). Failures already present at the baseline do not reject; unverifiable evidence never rejects but is listed as `attention` for the human at acceptance. Its decision table is tested row by row in `tests/evidence.test.js`.
- `src/preferences.js` / `src/shell-env.js` — per-machine preferences and the login-shell PATH lookup used by verification commands.
- `src/renderer/styles.css` — frosted-glass theme. Surfaces use the `.glass` / `.glass-strong` classes and the CSS variables at the top; light and dark follow the system.

Keep automated tests under `tests/`, static files under `assets/`, and scripts under `scripts/`. Mirror the `src/` layout in `tests/`.

## Build, Test, and Development Commands

- `npm install` — install dependencies (Electron).
- `npm start` / `npm run dev` — launch the app.
- `npm test` — run `tests/**/*.test.js` with the built-in `node:test` runner.

There is no build step, linter, or formatter configured yet. Do not introduce duplicate commands that bypass these scripts.

## Coding Style & Naming Conventions

Use the formatter and linter selected by the project configuration, and format changed files before opening a pull request. Until a language-specific configuration exists, use two spaces for JavaScript, TypeScript, JSON, YAML, and Markdown; use four spaces for Python. Use `camelCase` for variables and functions, `PascalCase` for classes and components, and `kebab-case` for directories and command-line scripts. Prefer small modules with descriptive names over catch-all files.

## Testing Guidelines

Place tests in `tests/`, using the same path and module name as the code under test. Name tests with the framework’s conventional suffix, such as `*.test.ts` or `test_*.py`. Every behavior change should include a focused regression test when practical. Run the full configured test command locally before submitting a pull request; report any unavailable or failing checks in the PR description.

## Commit & Pull Request Guidelines

Use concise imperative messages, preferably in Conventional Commit form (for example, `feat: add task parser` or `fix: handle empty input`). Pull requests should explain the problem and solution, link related issues, list validation commands and results, and include screenshots or recordings for user-facing changes.

## Security & Configuration

Never commit credentials, tokens, private keys, or machine-specific settings. Add safe defaults to an example file such as `.env.example`, keep real values in local environment files, and document required configuration in the project README as the application develops.

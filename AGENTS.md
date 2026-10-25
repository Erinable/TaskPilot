# Repository Guidelines

## Project Structure & Module Organization

TaskPilot is an Electron app built with electron-vite: TypeScript in the main process and preload, Vue 3 + Pinia + Element Plus + UnoCSS in the renderer.

- `src/main/index.ts` — main process: window creation and IPC registration. In dev it loads the electron-vite dev server, otherwise `out/renderer/index.html`.
- `src/main/env.ts` — the only reader of `process.env` in the main process.
- `src/main/ipc.ts` — assembles the IPC layer; testable with a fake `ipcMain`. Each domain registers its channels in `src/main/ipc/<domain>.ts` (`register(ipcMain, ctx, services)`), which only validates arguments and routes. Shared state (stores, config, preferences, the background run registry, `record`/`recordCall`) lives in `src/main/app_context.ts`; longer flows live in IPC-free services: `coding_service.ts` (the Coding Agent loop, over `coding_runtime.ts`), `review_service.ts` (QA, Architect's ruling, the baseline) and `practice_service.ts` (reference and grade). Tests mirror this under `tests/main/ipc/`, sharing `tests/main/ipc/harness.ts`.
- `src/main/background_runs.ts` — the registry of background runs. Every run that outlives its IPC call registers its controller and promise here; cancelling on a switch, reset or quit, the switch dialog's busy list and the team's busy work are all read from it, so a new kind of run only needs to register.
- `src/shared/ipc_channels.ts` / `src/shared/ipc_types.ts` — channel names and the typed wire contract shared by main, preload and renderer. `src/shared` must not import from `src/main`.
- `src/preload/index.ts` — exposes `window.taskpilot` (typed as `TaskPilotApi`) via `contextBridge`. It is bundled to CommonJS (`out/preload/index.cjs`) because sandboxed preloads cannot be ES modules.
- `src/main/tasks.ts` — the work-package definition types and the `TaskCatalog` interface. `RequirementStore` is the catalog: it serves the packages published from requirements as frozen, shared objects. Tests publish `tests/main/fixtures/sample_tasks.ts` through `SAMPLE_REQUIREMENT`.
- `src/main/activity_log.ts` — append-only activity events, one JSONL file per business day under the repository's `events/`, kept 30 days and pruned at startup. `app_context.ts` records every package transition and requirement outcome; the queue's metrics, the activity feed and team presence are computed from it (`activity:overview`). A failed append is logged and never fails the action; `activity:page` serves the full feed a few business days at a time. Day boundaries follow `env.businessTimeZone` (`TASKPILOT_TIME_ZONE`, default `Asia/Shanghai`), the single business time zone: the preload passes it to the renderer as `window.taskpilot.businessTimeZone`, read through `src/renderer/src/lib/time_zone.ts`.
- `src/main/engineering_map.ts` — the engineering map: Architect's module summaries from every requirement merged by file (newest wins), each marked stale when the file's blob changed since it was read, beside the tracked file tree (capped at 5000 paths). It never calls a model.
- `src/renderer/src/` — the Vue app: `App.vue`, `views/` (one per top-level view), `components/`, `stores/` (Pinia setup stores), `lib/` (pure logic and IPC helpers). Agent-written text is rendered with `{{ }}` only, never `v-html`. The page has a strict CSP (`script-src 'self'`, `style-src 'self'` in production).
- `src/renderer/src/lib/icons.ts` + `components/AppIcon.vue` — the SVG icon set. `IconName` is typed, so vue-tsc rejects unknown names; `tests/renderer/icons.test.ts` also checks names in data.
- `src/renderer/src/stores/settings.ts` — settings state; `lib/settings_model.ts` holds its pure logic (dirty tracking, search). New settings pages need a nav entry in `SettingsView.vue`, a page component under `components/settings/`, and an entry in `PAGE_STORES`.
- `src/main/agents/` — the AI team. Each agent sees only its layer:
  - `architect.ts` reads code (through `src/main/repo_reader.ts`) and publishes a module interface summary;
  - `product_lead.ts` plans from the summary and the file list, and never sees source code;
  - `qa.ts` reviews a submitted package against its steps, scope and acceptance criteria. `decide()` combines the model's verdict with TaskPilot's own evidence: a failing blocking check or a failed/missing linked test rejects regardless of the model, and the model can only make a review stricter;
  - `env_steward.ts` (Environment Steward) reads the facts `env_setup.ts` gathers and picks an install mode and existing `package.json` script names. It never writes a command, and its suggested fixes are shown to the user but never run;
  - `release_manager.ts` (Release Manager) drafts a version bump, release notes and a pre-release checklist from the commit subjects, changed paths (no contents) and finished packages since the last release. Release Manager never tags, commits, pushes or runs release commands; its one repository write is inserting the notes into a `.md` file the user names (`release:write-notes`, path-checked). Releases and the draft live in the repository's `releases.json` (`src/main/release_store.ts`);
  - `pipeline.ts` runs Architect's steps, QA's review, the steward's plan and the release draft; `claude_cli.ts` runs the isolated, tool-less CLI.

  All model output is validated before use. Agent prompt changes should be checked with `npm run eval:product-lead -- --architect`, `npm run eval:qa` or `npm run eval:architect` (see the README in each `evals/` directory).
- `src/main/repo_reader.ts` — the only source of file contents for agents. It reads from git blobs, only tracked files, and refuses secret-looking paths. Any agent that needs code goes through it.
- `src/main/review_diff.ts` — the only source of working-tree diffs for QA. It reads only paths git reports as changed since the baseline (untracked included), refuses secret-looking paths with the same patterns as `repo_reader.ts`, skips binaries, caps sizes, and reports every skipped file.
- `src/main/env_setup.ts` — Node/npm environment setup. It probes tracked manifests, lockfiles, version pins and CI workflows, and builds every setup command from fixed npm options plus validated script names (`--ignore-scripts` unless the user allows lifecycle scripts). Packages the npm lockfile marks `hasInstallScript` (not optional) get a separate `npm rebuild <names>` step, so only they run scripts. The renderer only sends a step id; `ipc/environment.ts` rebuilds the command from the stored plan and runs it after the user's click.
- `src/main/workspace.ts` / `src/main/verification.ts` — verification checks (`test`, `lint`, `build`, `smoke`), each with a stage (`step` = manual, `submit` = runs before QA), a blocking flag, and a report format (`stdout` TAP/spec, or a JUnit file read by `src/main/test_report.ts`). `workspace.json` is version 2 (`checks`); v1 `commands` are upgraded on load.
- `src/main/evidence.ts` — pure rules that turn check runs into `pass / fail / unverifiable` evidence, comparing against the baseline measured when a package is claimed (clean tree only, in the background; see `measureBaseline` in `review_service.ts`). Failures already present at the baseline do not reject; unverifiable evidence never rejects but is listed as `attention` for the human at acceptance. Its decision table is tested row by row in `tests/main/evidence.test.ts`.
- `src/main/preferences.ts` / `src/main/shell_env.ts` — per-machine preferences and the login-shell PATH lookup used by verification commands.
- `src/main/git_commit.ts` — the only code that writes git history: `commit:create` commits an accepted package's uncommitted files inside its file scope, after the developer reviews the list and message. It recomputes the list and refuses if it changed, never passes `--no-verify`, never pushes, amends or switches branches; secret-looking and out-of-scope files are listed and left for the developer. `src/main/git.ts` stays read-only.
- `src/main/agents/tutor.ts` / `src/main/tutor_store.ts` — Tutor explains one step to a beginner on request (`tutor:ask`), from the package's scope files as committed (read through `repo_reader.ts`). No tools, validated output rendered as text; answers are cached per step in the repository's `tutor.json` and keyed on the step's text, so a replan invalidates them.
- `src/main/note_store.ts` — learning notes, global: a folder of Markdown files (default `userData/notes/`, or a folder the user picks, e.g. an Obsidian vault). Title = file name; TaskPilot's fields live in YAML frontmatter, other fields are kept. A watcher picks up outside edits and a save refuses to overwrite a changed file unless forced. `src/shared/note_markdown.ts` finds `[[links]]`, `#tags` and headings (never inside code) for both processes; `components/notes/NoteMarkdown.vue` renders the syntax tree as Vue nodes, never HTML. Grading reads each note's title and summary (`notes:summarize`, on request), not the body.
- `src/main/repositories.ts` — the repository registry (`userData/repositories.json`). Each repository, identified by its git top-level path, keeps its own `workspace.json`, requirements, work package state, releases and events in `userData/repos/<id>/`; preferences stay global. Files from before repositories move there once at startup, after a copy to `userData/backup-before-repositories/`. A switch (`repositories:switch` in `ipc/repositories.ts`) cancels every background run, waits for its writes, then reopens the stores in order (requirements, whose published packages are the task catalog, then work packages); the renderer asks before cancelling (`stores/repositories.ts`) and remounts the views.
- `src/renderer/src/assets/styles.css` — frosted-glass theme. Surfaces use the `.glass` / `.glass-strong` classes and the CSS variables at the top; light and dark follow the system. `element_theme.css` maps Element Plus variables onto it.
- Main-process source must not contain the text `require(`, `__dirname` or `__filename`: electron-vite then injects a CommonJS shim that can land inside a string literal (guarded by `tests/migration.test.ts`).

Keep automated tests under `tests/`, static files under `assets/`, and scripts under `scripts/`. Mirror the `src/` layout in `tests/`.

## Build, Test, and Development Commands

- `npm install` — install dependencies.
- `npm run dev` — electron-vite dev server with hot reload.
- `npm run build` — bundle main, preload and renderer into `out/`.
- `npm start` — run the built app (`electron-vite preview`).
- `npm test` — run `tests/**/*.test.ts` with Vitest. Component tests opt into a DOM with `// @vitest-environment happy-dom`.
- `npm run typecheck` — vue-tsc over main, preload, renderer and tests.
- `npm run lint` — ESLint (`eslint.config.ts`): checks the conventions below that a tool can (const arrow functions, // comments, inline exports, no `v-html`/`innerHTML`, `process.env` only in `src/main/env.ts`, no explicit `any`).
- `npm run format` / `npm run format:check` — Prettier (`.prettierrc.json`). The one-time formatting commit is listed in `.git-blame-ignore-revs`.
- `npm run eval:product-lead` / `eval:qa` / `eval:architect` — eval harnesses for Product Lead, QA and Architect (real model calls, cost money); Node runs the `.ts` files directly.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format:check, test and build on Ubuntu and macOS. Do not introduce duplicate commands that bypass these scripts.

## Coding Style & Naming Conventions

Stack: electron-vite + TypeScript + Vue 3 + Pinia + Element Plus + UnoCSS, tested with Vitest. All source is TypeScript or Vue.

- Indent with two spaces (JS, TS, Vue, JSON, YAML, Markdown).
- File and directory names are lowercase joined with underscores, for example work_package_store.ts. Vue components are PascalCase .vue files. Project imports carry their full suffix (.ts, .vue).
- camelCase for variables and functions, PascalCase for classes, types and Vue components.
- Spell names out in full (groupId, not gid). Loop variables use the singular of the collection (for (const row of rows)); short names only in one-line lambdas.
- Define functions with const arrow functions, not function declarations. Return in one line when the body is one expression.
- Comments use // only.
- Export inline where a symbol is defined; no aggregated export { a, b } at the end of a file.
- Library imports first, project imports below, one blank line between. More than three imports from one project module use a namespace import (import * as store from './work_package_store').
- Internal config that is missing throws; do not paper over it with || defaults. Defaults with || are for external input only.
- No (x as any).prop = value to get around types.
- process.env is read in one config module only; everything else imports from it.
- No over-abstraction: one-off logic stays inline instead of becoming a helper. Prefer small modules with descriptive names over catch-all files.
- Renderer templates use {{ }} interpolation only, never v-html.

## Testing Guidelines

Place tests in `tests/`, using the same path and module name as the code under test. Name tests with the framework’s conventional suffix, such as `*.test.ts` or `test_*.py`. Every behavior change should include a focused regression test when practical. Run the full configured test command locally before submitting a pull request; report any unavailable or failing checks in the PR description.

## Commit & Pull Request Guidelines

Use concise imperative messages, preferably in Conventional Commit form (for example, `feat: add task parser` or `fix: handle empty input`). Pull requests should explain the problem and solution, link related issues, list validation commands and results, and include screenshots or recordings for user-facing changes.

## Security & Configuration

Never commit credentials, tokens, private keys, or machine-specific settings. Add safe defaults to an example file such as `.env.example`, keep real values in local environment files, and document required configuration in the project README as the application develops.

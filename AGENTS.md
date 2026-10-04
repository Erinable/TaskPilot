# Repository Guidelines

## Project Structure & Module Organization

TaskPilot is an Electron app using plain HTML, CSS, and JavaScript (no bundler).

- `src/main.js` — main process: window creation and IPC registration.
- `src/ipc.js` — IPC channel names and handlers; testable with a fake `ipcMain`.
- `src/preload.js` — exposes `window.taskpilot` to the renderer via `contextBridge`. It runs sandboxed, so it can only `require('electron')`; channel names are duplicated here and guarded by `tests/ipc.test.js`.
- `src/tasks.js` — sample work-package data, the single source of truth until real integrations exist.
- `src/renderer/` — UI. Build DOM with `textContent`/DOM APIs, never `innerHTML` with data. The page has a strict CSP (`script-src 'self'`, `style-src 'self'`), so no inline scripts or styles.
- `src/renderer/icons.js` — the SVG icon set. Use `<i data-icon="name">` in markup or `icon('name')` in `renderer.js`; `tests/renderer/icons.test.js` fails on any unknown name.
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

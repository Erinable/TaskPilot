import { readFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const TEST_FILES = 'tests/**/*.test.{js,ts}';

// A file that tags itself `@module-tag integration` (or any test in it
// `integration` / `e2e`) starts git, npm and compiler children, so it runs in
// its own project with half the CPUs; every other file is a unit test and
// runs on all of them, in threads, which start faster than forks.
const heavyFiles = globSync(TEST_FILES).filter((file) => /@module-tag integration|tags: \[[^\]]*'(?:integration|e2e)'/.test(readFileSync(file, 'utf8')));

// Renderer component tests opt into a DOM with `// @vitest-environment happy-dom`.
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/renderer_globals.ts', 'tests/setup/console_guard.ts'],
    // Transformed modules are kept in node_modules/.vitest-cache across runs.
    fsModuleCache: true,
    // Untagged tests are unit tests under the default 5s. A file tags itself
    // with `/** @module-tag integration */`; a test that drives external tools
    // or the sandbox carries `{ tags: ['e2e'] }`. Tests never set their own
    // timeout, and `npm run test:fast` leaves e2e out.
    tags: [
      { name: 'integration', description: 'Temp repositories, the IPC harness, child processes or a full view mount.', timeout: 30_000 },
      { name: 'e2e', description: 'Drives uv, python3, cargo, cc, make, perl or Seatbelt end to end.', timeout: 600_000 },
    ],
    projects: [
      { extends: true, test: { name: 'unit', include: [TEST_FILES], exclude: heavyFiles, pool: 'threads', sequence: { groupOrder: 0 } } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: heavyFiles,
          // Half the CPUs, so integration deadlines are not CPU-starved.
          maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

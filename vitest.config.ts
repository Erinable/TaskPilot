import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Renderer component tests opt into a DOM with `// @vitest-environment happy-dom`.
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  test: {
    include: ['tests/**/*.test.{js,ts}'],
    environment: 'node',
    setupFiles: ['tests/setup/renderer_globals.ts'],
    // Each worker can start git, npm and compiler children; cap fan-out as well
    // as using half the CPUs so integration deadlines are not CPU-starved.
    maxWorkers: Math.min(2, Math.max(1, Math.floor(availableParallelism() / 2))),
    // Untagged tests are unit tests under the default 5s. A file tags itself
    // with `/** @module-tag integration */`; a test that drives external tools
    // or the sandbox carries `{ tags: ['e2e'] }`. Tests never set their own
    // timeout, and `npm run test:fast` leaves e2e out.
    tags: [
      { name: 'integration', description: 'Temp repositories, the IPC harness, child processes or a full view mount.', timeout: 30_000 },
      { name: 'e2e', description: 'Drives uv, python3, cargo, cc, make, perl or Seatbelt end to end.', timeout: 600_000 },
    ],
  },
});

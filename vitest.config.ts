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
  },
});

import { resolve } from 'node:path';
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
    // Integration tests spawn git, npm and Electron-free app stacks; running a
    // worker per CPU starves them past their timeouts.
    maxWorkers: '50%',
  },
});

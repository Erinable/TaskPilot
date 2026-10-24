import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import unocss from 'unocss/vite';
import type { Plugin } from 'vite';

// The page ships with a strict CSP. The dev server injects component styles as
// <style> tags and talks to the page over a websocket, so only dev relaxes it.
const devCsp = (): Plugin => ({
  name: 'taskpilot-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace("font-src 'self'", "font-src 'self'; connect-src 'self' ws:"),
});

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [vue(), unocss(), devCsp()],
    // The CSP allows fonts from 'self' only, so KaTeX's small fonts must
    // stay files instead of being inlined as data: URLs.
    build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined) },
  },
});

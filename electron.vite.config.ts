import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import unocss from 'unocss/vite';
import components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
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
    build: { rolldownOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { rolldownOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    // Element Plus components are imported where a template uses them instead
    // of the whole library. Their styles are listed in mount_app.ts, ahead of
    // element_theme.css, so a lazily loaded view cannot reorder them after the
    // theme's overrides. No generated components.d.ts: type checking is as before.
    plugins: [vue(), unocss(), components({ resolvers: [ElementPlusResolver({ importStyle: false })], dts: false }), devCsp()],
    // The CSP allows fonts from 'self' only, so KaTeX's small fonts must
    // stay files instead of being inlined as data: URLs.
    // Gzip sizes cost build time and nobody downloads this bundle.
    build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined), reportCompressedSize: false },
  },
});

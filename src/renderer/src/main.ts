import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'virtual:uno.css';

import App from './App.vue';
import './assets/styles.css';
import './assets/element_theme.css';

// Element Plus switches palettes on html.dark; follow the system scheme,
// which the main process drives through nativeTheme.themeSource.
const scheme = window.matchMedia('(prefers-color-scheme: dark)');
const syncScheme = () => document.documentElement.classList.toggle('dark', scheme.matches);
syncScheme();
scheme.addEventListener('change', syncScheme);

createApp(App).use(createPinia()).use(ElementPlus).mount('#app');

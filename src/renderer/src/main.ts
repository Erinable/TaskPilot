import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs';
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

// Full screen hides the window buttons the top bar leaves room for.
window.taskpilot.onFullScreen((fullScreen) => document.documentElement.classList.toggle('full-screen', fullScreen));

createApp(App).use(createPinia()).use(ElementPlus, { locale: zhCn }).mount('#app');

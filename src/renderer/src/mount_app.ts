// The app itself: Vue, Element Plus and every view. Loaded by main.ts in its
// own chunk, so the splash paints without waiting for this bundle to parse.
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ElMessage, ElMessageBox, provideGlobalConfig } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs';

// Common Element Plus styles load once here. Styles used only by lazy views
// (date-picker, tree, segmented, input-number) load with the owning component.
// element_theme.css makes shared picker overrides more specific than the lazy
// vendor rules, so a late CSS load cannot change the theme's floating surfaces.
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/checkbox-group/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/dropdown/style/css';
import 'element-plus/es/components/dropdown-item/style/css';
import 'element-plus/es/components/dropdown-menu/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/option-group/style/css';
import 'element-plus/es/components/popover/style/css';
import 'element-plus/es/components/radio/style/css';
import 'element-plus/es/components/radio-button/style/css';
import 'element-plus/es/components/radio-group/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/tooltip/style/css';
// Toasts and confirm dialogs (lib/feedback.ts).
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'virtual:uno.css';

import App from './App.vue';
import './assets/styles.css';
import './assets/element_theme.css';

export const mountApp = () => {
  // Element Plus switches palettes on html.dark; follow the system scheme,
  // which the main process drives through nativeTheme.themeSource.
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const syncScheme = () => document.documentElement.classList.toggle('dark', scheme.matches);
  syncScheme();
  scheme.addEventListener('change', syncScheme);

  // Full screen hides the window buttons the top bar leaves room for.
  window.taskpilot.app.onFullScreen((fullScreen) => document.documentElement.classList.toggle('full-screen', fullScreen));

  const app = createApp(App).use(createPinia());
  // What app.use(ElementPlus, { locale }) did, without registering every
  // component: the Chinese locale for every component and message box, and
  // toasts and confirms rendered in the app's context.
  provideGlobalConfig({ locale: zhCn }, app, true);
  app.use(ElMessage).use(ElMessageBox);
  app.mount('#app');
};

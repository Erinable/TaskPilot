// Entry point. Only the splash and its styles load here; the app follows in
// its own chunk (mount_app.ts), fetched while the main process loads its
// stores. App.vue hides the splash once its first data is in.
import { describeError } from './lib/errors.ts';
import { call } from './lib/ipc.ts';
import * as splash from './lib/splash.ts';
import './assets/tokens.css';
import './assets/splash.css';

const loadApp = () => import('./mount_app.ts');
// Parsing the app bundle blocks the page, so it starts after the splash has
// painted (a frame, then a task), still alongside the main process's load.
let app = new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))).then(loadApp);

// Nothing may call the main process before its stores are loaded, so the app
// mounts only once startupReady resolves.
const start = async (retry: boolean) => {
  splash.showSplashLoading();
  try {
    await call(window.taskpilot.app.ready(retry));
    (await app).mountApp();
  } catch (error) {
    console.error('[startup] TaskPilot could not start', error);
    // A bundle that failed to load is fetched again on retry.
    app = app.catch(loadApp);
    splash.showSplashError(describeError(error));
  }
};

splash.onSplashRetry(() => start(true).catch((error) => console.error(error)));
start(false).catch((error) => console.error(error));

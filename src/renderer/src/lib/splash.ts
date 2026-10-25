// The splash screen in index.html. It is plain markup, so it shows before the
// app bundle has loaded; this module turns it into an error with a retry
// button when the main process fails to start, and fades it out once the
// first data is in.
const FADE_MS = 240;

const parts = () => {
  const root = document.getElementById('splash');
  if (!root) return null;
  return { root, message: root.querySelector<HTMLElement>('.splash-message')!, retry: root.querySelector<HTMLButtonElement>('.splash-retry')! };
};

export const onSplashRetry = (listener: () => void) => parts()?.retry.addEventListener('click', listener);

export const showSplashLoading = () => {
  const splash = parts();
  if (!splash) return;
  splash.root.classList.remove('failed');
  splash.root.setAttribute('aria-busy', 'true');
  splash.message.textContent = '正在启动…';
  splash.message.removeAttribute('role');
};

export const showSplashError = (message: string) => {
  const splash = parts();
  if (!splash) return;
  splash.root.classList.add('failed');
  splash.root.setAttribute('aria-busy', 'false');
  splash.message.textContent = `启动失败：${message}`;
  splash.message.setAttribute('role', 'alert');
  splash.retry.focus();
};

// Removed after the fade; reduced motion makes the transition near-instant.
export const hideSplash = () => {
  const splash = parts();
  if (!splash) return;
  splash.root.classList.add('leaving');
  setTimeout(() => splash.root.remove(), FADE_MS);
};

// The main process's only reader of process.env; everything else imports env.
export const env = {
  // Set by electron-vite dev; the renderer is then served with hot reload.
  rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  shell: process.env.SHELL ?? null,
  path: process.env.PATH ?? '',
  pathExt: process.env.PATHEXT,
};

// Child processes inherit the whole environment, so they get a copy of it.
export const processEnv = () => ({ ...process.env });

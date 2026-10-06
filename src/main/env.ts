// The main process's only reader of process.env; everything else imports env.
export const env = {
  // Set by electron-vite dev; the renderer is then served with hot reload.
  rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  shell: process.env.SHELL ?? null,
  path: process.env.PATH ?? '',
  pathExt: process.env.PATHEXT,
  // Business time zone (IANA name): day boundaries for activity and weekly
  // metrics follow it. Storage stays UTC.
  businessTimeZone: process.env.TASKPILOT_TIME_ZONE ?? 'Asia/Shanghai',
};

// Child processes inherit the whole environment, so they get a copy of it.
export const processEnv = () => ({ ...process.env });

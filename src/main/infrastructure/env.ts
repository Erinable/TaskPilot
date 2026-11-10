// The main process's only reader of process.env; everything else imports env.
export const env = {
  // Set by electron-vite dev; the renderer is then served with hot reload.
  rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  // An explicit isolated profile for local smoke tests and recovery rehearsals.
  dataDir: process.env.TASKPILOT_DATA_DIR ?? null,
  shell: process.env.SHELL ?? null,
  path: process.env.PATH ?? '',
  pathExt: process.env.PATHEXT,
  toolHomes: {
    nvm: process.env.NVM_DIR,
    fnm: process.env.FNM_DIR,
    volta: process.env.VOLTA_HOME,
    asdf: process.env.ASDF_DATA_DIR,
    mise: process.env.MISE_DATA_DIR,
    bun: process.env.BUN_INSTALL,
    npmPrefix: process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX,
    xdgData: process.env.XDG_DATA_HOME,
  },
  // Business time zone (IANA name): day boundaries for activity and weekly
  // metrics follow it. Storage stays UTC.
  businessTimeZone: process.env.TASKPILOT_TIME_ZONE ?? 'Asia/Shanghai',
};

// Child processes inherit the whole environment, so they get a copy of it.
export const processEnv = () => ({ ...process.env });

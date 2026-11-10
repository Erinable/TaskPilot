// Offline discovery of conventional per-machine tool installations. Nothing is
// executed and no workspace path or shell startup file is inspected.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ToolHomes = {
  nvm?: string;
  fnm?: string;
  volta?: string;
  asdf?: string;
  mise?: string;
  bun?: string;
  npmPrefix?: string;
  xdgData?: string;
};
export type DiscoveryOptions = {
  home?: string;
  platform?: NodeJS.Platform;
  inherited?: string;
  toolHomes?: ToolHomes;
  // Tests replace machine-wide locations rather than inspecting the host.
  systemPaths?: readonly string[];
};
const CLI_NAMES = ['claude', 'codex', 'pi', 'grok', 'opencode'];
const TOOL_NAMES = [...CLI_NAMES, 'node', 'npm', 'npx', 'git', 'python3', 'uv', 'cargo', 'rustc', 'make', 'cc', 'sh', 'bash'];
export const MAX_MANAGER_ENTRIES = 128;
export const MAX_VERSION_CANDIDATES = 8;
const MAX_ALIAS_DEPTH = 8;
const MAX_DISCOVERED_PATHS = 32;
const VERSION = /^v?\d+(?:\.\d+){0,2}$/;
const excluded = (directory: string) => directory.split(path.sep).some((part) => ['node_modules', 'cache', 'caches', '.cache'].includes(part));
const absolute = (directory: string | undefined): directory is string => Boolean(directory && path.isAbsolute(directory));
const directoryExists = (directory: string) =>
  fs.stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
const executable = async (file: string) => {
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const hasTool = async (directory: string, names: readonly string[]) =>
  (await Promise.all(names.map((name) => executable(path.join(directory, name))))).some(Boolean);

// opendir bounds work even when a manager directory contains thousands of
// unrelated entries. Version-shaped names alone can become candidate bins.
const installedVersions = async (directory: string): Promise<string[]> => {
  try {
    const handle = await fs.opendir(directory);
    const names: string[] = [];
    try {
      for (let count = 0; count < MAX_MANAGER_ENTRIES; count += 1) {
        const entry = await handle.read();
        if (!entry) break;
        if ((entry.isDirectory() || entry.isSymbolicLink()) && VERSION.test(entry.name)) names.push(entry.name);
      }
    } finally {
      await handle.close();
    }
    return names.sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
  } catch {
    return [];
  }
};

const nvmDefault = async (root: string): Promise<string | null> => {
  let alias = 'default';
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    if (
      seen.has(alias) ||
      alias.length > 128 ||
      !/^[a-zA-Z0-9_.*-]+(?:\/[a-zA-Z0-9_.*-]+)?$/.test(alias) ||
      alias.split('/').some((part) => part === '.' || part === '..')
    )
      return null;
    seen.add(alias);
    try {
      const file = path.join(root, 'alias', alias);
      if ((await fs.stat(file)).size > 4096) return null;
      alias = (await fs.readFile(file, 'utf8')).trim();
      if (VERSION.test(alias)) return alias.replace(/^v/, '');
    } catch {
      // nvm's node/stable aliases mean the latest installed Node version.
      return null;
    }
  }
  return null;
};

const versionBins = async (root: string, suffix: readonly string[], preferred: string | null = null): Promise<string[]> => {
  const versions = await installedVersions(root);
  const preferredVersion =
    preferred &&
    versions.find((version) => {
      const text = version.replace(/^v/, '');
      return text === preferred || text.startsWith(`${preferred}.`);
    });
  const ordered = preferredVersion ? [preferredVersion, ...versions.filter((version) => version !== preferredVersion)] : versions;
  const bins: string[] = [];
  for (const version of ordered.slice(0, MAX_VERSION_CANDIDATES)) {
    const bin = path.join(root, version, ...suffix);
    if (!(await executable(path.join(bin, 'node')))) continue;
    // Keep one preferred/latest runtime plus versions containing a CLI. Merely
    // having many installed Node versions must not widen the process PATH.
    if (bins.length === 0 || (await hasTool(bin, CLI_NAMES))) bins.push(bin);
    if (bins.length >= 4) break;
  }
  return bins;
};

const installationHome = (configured: string | undefined, fallback: string) => (absolute(configured) ? configured : fallback);
const installationRoots = (home: string, configured: ToolHomes) => {
  const data = installationHome(configured.xdgData, path.join(home, '.local', 'share'));
  return {
    data,
    nvm: installationHome(configured.nvm, path.join(home, '.nvm')),
    fnm: installationHome(configured.fnm, path.join(data, 'fnm')),
    asdf: installationHome(configured.asdf, path.join(home, '.asdf')),
    mise: installationHome(configured.mise, path.join(data, 'mise')),
    volta: installationHome(configured.volta, path.join(home, '.volta')),
    bun: installationHome(configured.bun, path.join(home, '.bun')),
  };
};

export const discoverToolPaths = async ({
  home = os.homedir(),
  platform = process.platform,
  inherited = '',
  toolHomes = {},
  systemPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
}: DiscoveryOptions = {}): Promise<string[]> => {
  if (platform === 'win32' || !path.isAbsolute(home)) return [];
  const roots = installationRoots(home, toolHomes);
  const candidates = [
    ...systemPaths,
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(roots.bun, 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(roots.data, 'claude', 'bin'),
    ...(absolute(toolHomes.npmPrefix) ? [path.join(toolHomes.npmPrefix, 'bin')] : []),
  ];
  const managers = await Promise.all([
    nvmDefault(roots.nvm).then((preferred) => versionBins(path.join(roots.nvm, 'versions', 'node'), ['bin'], preferred)),
    versionBins(path.join(roots.fnm, 'node-versions'), ['installation', 'bin']),
    versionBins(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin']),
    versionBins(path.join(roots.mise, 'installs', 'node'), ['bin']),
    versionBins(path.join(roots.asdf, 'installs', 'nodejs'), ['bin']),
    versionBins(path.join(roots.volta, 'tools', 'image', 'node'), ['bin']),
  ]);
  // Analysis runs use an isolated HOME. Prefer real installations over manager
  // shims, whose Node selection otherwise depends on files in the user's HOME.
  candidates.push(...managers.flat(), path.join(roots.volta, 'bin'), path.join(roots.asdf, 'shims'), path.join(roots.mise, 'shims'));
  const discovered: string[] = [];
  const canonical = new Set<string>();
  const add = async (directory: string) => {
    const normalized = path.normalize(directory);
    if (!absolute(normalized) || excluded(normalized) || discovered.includes(normalized) || discovered.length >= MAX_DISCOVERED_PATHS) return;
    if (!(await directoryExists(normalized)) || !(await hasTool(normalized, TOOL_NAMES))) return;
    const real = await fs.realpath(normalized).catch(() => null);
    if (!real || excluded(real) || canonical.has(real)) return;
    canonical.add(real);
    discovered.push(normalized);
  };
  for (const candidate of candidates) if (absolute(candidate)) await add(candidate);
  // A conventional shim can point at another installed runtime. Inspect only
  // these known executable links, never traverse arbitrary directory trees.
  const linkPaths = [...new Set([...discovered, ...inherited.split(path.delimiter).filter(absolute)])];
  for (const directory of linkPaths) {
    if (excluded(directory)) continue;
    const real = await fs.realpath(directory).catch(() => null);
    if (real && ['bin', 'shims'].includes(path.basename(real))) await add(real);
    for (const name of TOOL_NAMES.slice(0, CLI_NAMES.length + 1)) {
      const target = await fs.readlink(path.join(directory, name)).catch(() => null);
      if (!target) continue;
      const bin = path.dirname(path.resolve(directory, target));
      if (['bin', 'shims'].includes(path.basename(bin))) await add(bin);
    }
  }
  return discovered;
};

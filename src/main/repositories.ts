// The repositories TaskPilot knows, which one is open, and where each keeps
// its data: userData/repos/<id>/ holds that repository's workspace.json,
// requirements, work package state, releases and activity events.
// Preferences stay global in userData.
//
// [人工决策-2026-10-07 14:31:37] 仓库按 git 根目录路径区分（id 取路径哈希，同 VS Code workspaceStorage），不用 git remote；同一远程的两份克隆是两个仓库。
// [人工决策-2026-10-07 14:31:37] 验证命令每个仓库一套（workspace.json 进各仓库目录），全局只留仓库列表和当前仓库。
// [人工决策-2026-10-07 14:31:37] 升级时旧数据整体备份后归到当前已配置的仓库；未配置则先放 unassigned，第一次添加仓库时整体归过去。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as workspace from './workspace.ts';
import { jsonText, writeFileAtomic } from './atomic_json_file.ts';
import { EVENTS_DIRNAME } from './activity_log.ts';
import { RELEASES_FILENAME } from './release_store.ts';
import { REQUIREMENTS_FILENAME } from './requirement_store.ts';
import { STATE_FILENAME } from './work_package_store.ts';
import { TUTOR_FILENAME } from './tutor_store.ts';

export const REGISTRY_FILENAME = 'repositories.json';
export const REGISTRY_VERSION = 1;
export const REPOS_DIRNAME = 'repos';
// Data kept while no repository has been added yet.
export const UNASSIGNED_ID = 'unassigned';
// A copy of the pre-repository files, taken once before they move.
export const BACKUP_DIRNAME = 'backup-before-repositories';
// What lives in each repository's directory.
export const REPO_FILES = [workspace.CONFIG_FILENAME, REQUIREMENTS_FILENAME, STATE_FILENAME, RELEASES_FILENAME, EVENTS_DIRNAME, TUTOR_FILENAME];

export interface RepositoryEntry {
  id: string;
  // The git top level, as validated when added or relocated.
  root: string;
  addedAt: string;
  lastOpenedAt: string;
}

interface Registry {
  version: number;
  current: string | null;
  repositories: RepositoryEntry[];
}

// Directory names come from the path hash; the registry is the authority on
// which root an id belongs to, so a relocated repository keeps its id.
export const repositoryId = (root: string) => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);

const isEntry = (value: unknown): value is RepositoryEntry => {
  const entry = value as RepositoryEntry | null;
  return Boolean(entry) && /^[0-9a-f]{16}$/.test(entry!.id) && typeof entry!.root === 'string' && path.isAbsolute(entry!.root);
};

// Symlinks count as the same place (macOS /tmp is /private/tmp, and git
// reports the resolved one). A path that no longer exists compares as typed.
const realPath = (file: string) => fs.realpath(file).catch(() => path.resolve(file));
const samePath = async (a: string, b: string) => (await realPath(a)) === (await realPath(b));

const findByRoot = async (entries: RepositoryEntry[], root: string) => {
  for (const entry of entries) if (await samePath(entry.root, root)) return entry;
  return null;
};

const exists = async (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

export class RepositoryRegistry {
  #configDir: string;
  #registry: Registry = { version: REGISTRY_VERSION, current: null, repositories: [] };
  #now: () => Date;

  constructor(configDir: string, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.#configDir = configDir;
    this.#now = now;
  }

  // Reads the registry, moving pre-repository files into place the first time.
  async load(): Promise<this> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.#configDir, REGISTRY_FILENAME), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#migrate();
      return this;
    }
    const saved = JSON.parse(raw) as Partial<Registry> | null;
    const repositories = (Array.isArray(saved?.repositories) ? saved.repositories : []).filter(isEntry);
    const current = repositories.some((entry) => entry.id === saved?.current) ? saved!.current! : null;
    this.#registry = { version: REGISTRY_VERSION, current, repositories };
    return this;
  }

  // Moves the files TaskPilot kept directly in userData into the configured
  // repository's directory (or unassigned), after copying them to a backup.
  // The registry is written last, so an interrupted move is finished on the
  // next start: files still in userData are moved again.
  async #migrate() {
    const legacy: string[] = [];
    for (const name of REPO_FILES) if (await exists(path.join(this.#configDir, name))) legacy.push(name);
    let root: string | null = null;
    if (legacy.length > 0) {
      const backup = path.join(this.#configDir, BACKUP_DIRNAME);
      await fs.mkdir(backup, { recursive: true });
      for (const name of legacy) await fs.cp(path.join(this.#configDir, name), path.join(backup, name), { recursive: true, force: false });
      // A broken workspace.json still moves; it just names no repository.
      root = await workspace.load(this.#configDir).then(
        (config) => config.root,
        () => null,
      );
    }
    const entry = root ? this.#newEntry(root) : null;
    const target = this.dataDir(entry?.id ?? UNASSIGNED_ID);
    await fs.mkdir(target, { recursive: true });
    for (const name of legacy) await fs.rename(path.join(this.#configDir, name), path.join(target, name));
    this.#registry = { version: REGISTRY_VERSION, current: entry?.id ?? null, repositories: entry ? [entry] : [] };
    await this.#persist();
    console.debug(`[repositories] migrated files=${legacy.length} target=${entry?.id ?? UNASSIGNED_ID}`);
  }

  #newEntry(root: string): RepositoryEntry {
    const at = this.#now().toISOString();
    let id = repositoryId(root);
    // A relocated repository keeps its old id, which can be this path's hash.
    while (this.#registry.repositories.some((entry) => entry.id === id)) id = crypto.randomBytes(8).toString('hex');
    return { id, root, addedAt: at, lastOpenedAt: at };
  }

  // Written through a temp file, so a crash never leaves half a registry.
  async #persist() {
    await fs.mkdir(this.#configDir, { recursive: true });
    const file = path.join(this.#configDir, REGISTRY_FILENAME);
    await writeFileAtomic(file, jsonText(this.#registry));
  }

  get current(): RepositoryEntry | null {
    return this.#registry.repositories.find((entry) => entry.id === this.#registry.current) ?? null;
  }

  // Most recently opened first.
  list(): RepositoryEntry[] {
    return [...this.#registry.repositories].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  get(id: string): RepositoryEntry | null {
    return this.#registry.repositories.find((entry) => entry.id === id) ?? null;
  }

  // Where a repository's data lives; the open one by default.
  dataDir(id: string = this.#registry.current ?? UNASSIGNED_ID) {
    return path.join(this.#configDir, REPOS_DIRNAME, id);
  }

  // The open repository's workspace config. The registry owns the root, so a
  // relocated repository's old path in workspace.json never wins.
  async loadConfig(): Promise<workspace.WorkspaceConfig> {
    const config = await workspace.load(this.dataDir());
    return { ...config, root: this.current?.root ?? null };
  }

  async saveConfig(raw: workspace.WorkspaceConfig): Promise<workspace.WorkspaceConfig> {
    return workspace.save(this.dataDir(), { ...raw, root: this.current?.root ?? null });
  }

  // Registers a validated root (an existing one is returned as is). The first
  // repository adopts the unassigned data. It does not open the repository.
  async add(root: string): Promise<RepositoryEntry> {
    const known = await findByRoot(this.#registry.repositories, root);
    if (known) return known;
    const entry = this.#newEntry(root);
    const unassigned = this.dataDir(UNASSIGNED_ID);
    await fs.mkdir(path.dirname(unassigned), { recursive: true });
    if (this.#registry.repositories.length === 0 && (await exists(unassigned))) await fs.rename(unassigned, this.dataDir(entry.id));
    this.#registry.repositories.push(entry);
    await this.#persist();
    if (this.#registry.current === null) await this.#syncRoot(entry);
    console.debug(`[repositories] added id=${entry.id}`);
    return entry;
  }

  // Makes `id` the open repository.
  async open(id: string): Promise<RepositoryEntry> {
    const entry = this.get(id);
    if (!entry) throw Object.assign(new Error(`Unknown repository: ${id}`), { code: 'unknown_repository' });
    entry.lastOpenedAt = this.#now().toISOString();
    this.#registry.current = id;
    await this.#persist();
    console.debug(`[repositories] opened id=${id}`);
    return entry;
  }

  // Points a repository at its new location (it was moved or renamed).
  async relocate(id: string, root: string): Promise<RepositoryEntry> {
    const entry = this.get(id);
    if (!entry) throw Object.assign(new Error(`Unknown repository: ${id}`), { code: 'unknown_repository' });
    const other = await findByRoot(
      this.#registry.repositories.filter((candidate) => candidate.id !== id),
      root,
    );
    if (other) throw Object.assign(new Error(`Already added: ${root}`), { code: 'repository_exists', field: 'root' });
    entry.root = root;
    await this.#persist();
    await this.#syncRoot(entry);
    return entry;
  }

  // Keeps workspace.json's root readable for anyone opening the file by hand.
  async #syncRoot(entry: RepositoryEntry) {
    const dir = this.dataDir(entry.id);
    const config = await workspace.load(dir).catch(() => workspace.emptyConfig());
    await workspace.save(dir, { ...config, root: entry.root });
  }
}

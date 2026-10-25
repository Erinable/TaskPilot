// Sandbox mode for the Coding Agent: the CLI runs as the current macOS user
// inside a Seatbelt profile (sandbox-exec) that TaskPilot writes, instead of
// as the separate taskpilot-coder account.
//
// The profile wraps the whole CLI process, so the CLI's own read/edit tools
// are confined as well as the commands it runs; no CLI's built-in sandbox is
// relied on (several do not cover their own tools, some have none).
//
// What the process may do:
//   write: its run directory (a git-archive copy of the package, never the
//          real repository), its own home (below), temp folders, and
//          folders the user added in settings
//   read:  everything outside the home folder; inside it only the above, the
//          toolchain on PATH (e.g. ~/.nvm), and folders the user added.
//          File names and sizes in home stay visible (Node needs lstat).
//   network: allowed; the CLI must reach its model API, and Seatbelt cannot
//          tell the CLI's requests from the commands it runs.
// Every git command on the run directory runs inside the profile too: the
// agent controls that directory's .git, so its config or hooks must never
// run outside the sandbox.
//
// The CLI runs with HOME set to a per-run folder holding copies of its
// credential and config files. The real state folders (~/.claude, ~/.codex
// ...) are neither readable nor writable: an agent that could write them
// could plant hooks or config the user's own CLI would run, unsandboxed, the
// next time. Only credential files are copied back after a run (an OAuth
// token may have rotated), and only when they are still JSON objects.
//
// [人工决策-2026-10-19] 沙箱逃逸修法选方案 1：每次运行给 CLI 一个临时 HOME，只复制登录凭据和必要配置；真实状态目录不可读写；运行后只回写变化过的凭据文件。
//
// [人工决策-2026-10-14] 新用户默认用沙箱模式；默认只给工作区权限，例外由用户在设置里添加；沙箱内可以联网。
// [人工决策-2026-10-14] 由 TaskPilot 自己用 sandbox-exec 包住 CLI 进程，不依赖各 CLI 自带的沙箱。
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentRuntimeConfig, CliId } from '../shared/agent_runtime.ts';
import { processEnv } from './env.ts';
import { writeFileAtomic } from './atomic_json_file.ts';

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
export const GIT_PATH = '/usr/bin/git';
export const TAR_PATH = '/usr/bin/tar';
export const RUNS_DIRNAME = 'coding-runs';
export const PROBE_FILENAME = 'coding-sandbox-probe.txt';
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// The files each CLI needs from the real home, relative to it. `credential`
// files are copied back after a run when they changed; `keys` keeps only
// those top-level JSON keys (Claude's settings also hold hooks and plugins,
// which must not reach the run).
export type HomeFile = { path: string; credential?: boolean; keys?: string[] };
export const CLI_HOME_FILES: Record<CliId, HomeFile[]> = {
  claude: [
    { path: '.claude/.credentials.json', credential: true },
    { path: '.claude/settings.json', keys: ['env', 'apiKeyHelper', 'model'] },
    { path: '.claude.json', keys: ['hasCompletedOnboarding', 'oauthAccount', 'userID', 'primaryApiKey', 'customApiKeyResponses'] },
  ],
  codex: [{ path: '.codex/auth.json', credential: true }, { path: '.codex/config.toml' }],
  pi: [{ path: '.pi/agent/auth.json', credential: true }, { path: '.pi/agent/models.json' }, { path: '.pi/agent/settings.json' }],
  grok: [{ path: '.grok/auth.json', credential: true }, { path: '.grok/config.toml' }],
  opencode: [
    { path: '.local/share/opencode/auth.json', credential: true },
    { path: '.config/opencode/opencode.json' },
    { path: '.config/opencode/opencode.jsonc' },
  ],
};
// The real state folder a self-check tries to write into; it must fail.
export const CLI_STATE_ROOT: Record<CliId, string> = {
  claude: '.claude',
  codex: '.codex',
  pi: '.pi',
  grok: '.grok',
  opencode: '.config/opencode',
};
const MAX_HOME_FILE_BYTES = 1024 * 1024;
// Never opened up by the toolchain rule, even when something on PATH lives there.
export const SENSITIVE = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gh',
  '.netrc',
  'Library',
  'Documents',
  'Desktop',
  'Downloads',
  'Pictures',
];

// Everything that varies per run, resolved by the IPC layer.
export interface SandboxContext {
  home: string;
  runRoot: string;
  // A file under home outside every allowed folder; the self-check must fail to read it.
  probeFile: string;
  // The PATH the CLI runs with (the login-shell PATH when configured).
  pathEntries: string[];
  extraRead: string[];
  extraWrite: string[];
  spawnFn?: SandboxSpawnFn;
}

export type SandboxChild = ReturnType<typeof nodeSpawn>;
export type SandboxSpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => SandboxChild;
const defaultSpawn: SandboxSpawnFn = (command, args, options) => nodeSpawn(command, [...args], options as never);

export class SandboxError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(message: string, code: string, stderr = '') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.stderr = stderr;
  }
}

// ========== Profile ==========

// macOS links /tmp, /var and /etc into /private; Seatbelt matches the real path.
const real = (target: string): string => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);

// The first folder under home holding `target`, unless it is sensitive.
const homeRootOf = (home: string, target: string): string | null => {
  const resolved = real(target);
  if (!within(home, resolved) || resolved === home) return null;
  const relative = path.relative(home, resolved).split(path.sep);
  const top = relative[0];
  if (SENSITIVE.some((name) => name.split('/')[0] === top)) return null;
  return path.join(home, top);
};

// Folders under home the toolchain lives in: each PATH entry, and where the
// CLI's executable really is (an nvm install, say).
export const toolchainRoots = (home: string, pathEntries: string[], executable: string | null): string[] => {
  const roots = new Set<string>();
  for (const entry of [...pathEntries, ...(executable ? [executable] : [])]) {
    const root = homeRootOf(home, entry);
    if (root) roots.add(root);
  }
  return [...roots];
};

export interface ProfileSpec {
  home: string;
  runDir: string;
  writable: string[];
  readable: string[];
}

// The Seatbelt profile text. Later rules win, so each deny is followed by
// the narrower allows it makes room for.
export const buildProfile = (spec: ProfileSpec): string => {
  const home = real(spec.home);
  const tmp = [real(os.tmpdir()), '/private/tmp', '/private/var/folders'];
  const paths = (list: string[]) => [...new Set(list.map(real))].map((entry) => `(subpath ${quote(entry)})`).join(' ');
  const writable = [real(spec.runDir), ...tmp, ...spec.writable];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${paths(writable)} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (literal "/dev/dtracehelper"))`,
    `(deny file-read* (subpath ${quote(home)}))`,
    // Names and sizes only; Node and git lstat every parent folder.
    `(allow file-read-metadata (subpath ${quote(home)}) (literal "/Users"))`,
    `(allow file-read* ${paths([spec.runDir, ...spec.writable, ...spec.readable])})`,
  ].join('\n');
};

// The run's own home, beside its directory: never inside it, or the agent's
// diff would include it.
export const agentHomeOf = (runDir: string) => `${runDir}-home`;

// Folders the CLI may write and read for one run. The real CLI state folders
// are not among them; the run's own home stands in for them.
export const profileFor = (context: SandboxContext, cli: CliId, runDir: string, executable: string | null): ProfileSpec => ({
  home: context.home,
  runDir,
  writable: [agentHomeOf(runDir), ...context.extraWrite],
  readable: [...toolchainRoots(context.home, context.pathEntries, executable), ...context.extraRead],
});

// ========== Environment ==========

// Model providers' keys, by name. Nothing else from the app's environment
// reaches the agent: no SSH agent socket, no cloud or GitHub tokens.
const PROVIDER_KEY =
  /^(?:ANTHROPIC|OPENAI|XAI|GROK|GEMINI|GOOGLE_GENERATIVE_AI|DEEPSEEK|MOONSHOT|OPENROUTER|MISTRAL|GROQ|ZAI|DASHSCOPE)_[A-Z0-9_]*(?:KEY|TOKEN|BASE_URL)$/;

// `agentHome` is the run's own home; caches and XDG folders live under it.
export const sandboxEnv = (context: SandboxContext, source: NodeJS.ProcessEnv = processEnv(), agentHome = context.home): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    HOME: agentHome,
    XDG_CONFIG_HOME: path.join(agentHome, '.config'),
    XDG_DATA_HOME: path.join(agentHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(agentHome, '.local', 'state'),
    XDG_CACHE_HOME: path.join(agentHome, '.cache'),
    npm_config_cache: path.join(agentHome, '.npm'),
    USER: source.USER ?? os.userInfo().username,
    LOGNAME: source.LOGNAME ?? os.userInfo().username,
    PATH: context.pathEntries.join(':'),
    TMPDIR: os.tmpdir(),
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const [key, value] of Object.entries(source)) if (PROVIDER_KEY.test(key) && value) env[key] = value;
  return env;
};

// ========== The run's own home ==========

// One file from the real home, as it goes into the run's home: a regular
// file (never a symlink), at most 1 MB, and for `keys` a filtered JSON object.
const seedContent = async (source: string, file: Pick<HomeFile, 'keys'>): Promise<string | null> => {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(source);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_HOME_FILE_BYTES) return null;
  const content = await fsp.readFile(source, 'utf8');
  if (!file.keys) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => file.keys?.includes(key)));
  return `${JSON.stringify(kept, null, 2)}\n`;
};

// Creates the run's home and copies in the CLI's sign-in and config files.
// Runs as TaskPilot, outside the profile, before the CLI starts.
export const seedAgentHome = async (context: SandboxContext, runDir: string, cli: CliId): Promise<string> => {
  const agentHome = agentHomeOf(runDir);
  await fsp.mkdir(agentHome, { recursive: true, mode: 0o700 });
  for (const file of CLI_HOME_FILES[cli]) {
    const content = await seedContent(path.join(context.home, file.path), file);
    if (content === null) continue;
    const target = path.join(agentHome, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(target, content, { mode: 0o600 });
  }
  return agentHome;
};

const jsonKeys = (content: string | null): string | null => {
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort().join('\u0000') : null;
  } catch {
    return null;
  }
};

// After a run, copies back credential files whose content changed (an OAuth
// refresh). Only an update in place: the real file must exist and both must
// be JSON objects with the same top-level keys, so the agent cannot add a
// login or reshape the file. Config and everything else stays behind.
export const syncCredentials = async (context: SandboxContext, runDir: string, cli: CliId): Promise<string[]> => {
  const agentHome = agentHomeOf(runDir);
  const updated: string[] = [];
  for (const file of CLI_HOME_FILES[cli].filter((entry) => entry.credential)) {
    const target = path.join(context.home, file.path);
    const written = await seedContent(path.join(agentHome, file.path), {});
    const current = await seedContent(target, {});
    const shape = jsonKeys(written);
    if (written === null || current === null || written === current || shape === null || shape !== jsonKeys(current)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, written, { tmp: `${target}.taskpilot-${randomUUID().slice(0, 8)}`, mode: 0o600 });
    updated.push(file.path);
  }
  return updated;
};

// ========== Running under the profile ==========

export const sandboxArgs = (profile: string, command: string, args: readonly string[]): string[] => ['-p', profile, command, ...args];

interface RunOptions {
  cwd: string;
  input?: string | NodeJS.ReadableStream;
  timeoutMs?: number;
  signal?: AbortSignal;
  // HOME for the command; the run's own home when the CLI runs.
  agentHome?: string;
}

// Runs one command under the profile and collects its output.
const runSandboxed = async (
  context: SandboxContext,
  profile: string,
  command: string,
  args: readonly string[],
  { cwd, input, timeoutMs = 60_000, signal, agentHome }: RunOptions,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  if (signal?.aborted) throw new SandboxError('Cancelled', 'workspace_aborted');
  const spawnFn = context.spawnFn ?? defaultSpawn;
  const child = spawnFn(SANDBOX_EXEC_PATH, sandboxArgs(profile, command, args), {
    cwd,
    env: sandboxEnv(context, processEnv(), agentHome ?? context.home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
    else stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString().slice(0, 64 * 1024 - stderr.length);
  });
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string; code: number }>();
  const stop = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  child.once('error', (error) => reject(new SandboxError('Could not start sandbox-exec', 'workspace_spawn_failed', error.message)));
  child.once('close', (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (signal?.aborted) reject(new SandboxError('Cancelled', 'workspace_aborted', stderr));
    else if (bytes > MAX_OUTPUT_BYTES) reject(new SandboxError('Output too large', 'workspace_process_failed', stderr));
    else resolve({ stdout, stderr, code: code ?? 1 });
  });
  if (typeof input === 'string' || input === undefined) child.stdin?.end(input ?? '');
  else input.pipe(child.stdin as NodeJS.WritableStream);
  return promise;
};

// ========== Run directories ==========

export const runDirOf = (context: SandboxContext, runName: string): string => {
  const resolved = path.isAbsolute(runName) ? runName : path.join(context.runRoot, runName);
  if (path.dirname(resolved) !== context.runRoot || !SAFE_NAME.test(path.basename(resolved))) {
    throw new SandboxError('Invalid coding run directory', 'workspace_invalid_run_name');
  }
  return resolved;
};

// git, with nothing from the agent's .git able to run a program.
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat'];

// A copy of `baseline` in a new run directory, committed so the agent's
// changes can be diffed. The real repository is read only by TaskPilot's
// own `git archive`, never inside the sandbox.
export const prepare = async (
  root: string,
  baseline: string,
  { context, runName, signal, cli }: { context: SandboxContext; runName?: string; signal?: AbortSignal; cli: CliId },
): Promise<{ runName: string; directory: string }> => {
  const runDir = runDirOf(context, runName ?? randomUUID());
  await fsp.mkdir(context.runRoot, { recursive: true, mode: 0o700 });
  await fsp.mkdir(runDir, { mode: 0o700 });
  await fsp.mkdir(agentHomeOf(runDir), { mode: 0o700 });
  const profile = buildProfile(profileFor(context, cli, runDir, null));
  try {
    const archive = (context.spawnFn ?? defaultSpawn)(GIT_PATH, ['-C', root, 'archive', '--format=tar', baseline], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const archived = new Promise<number>((resolve) => archive.once('close', (code) => resolve(code ?? 1)));
    // bsdtar refuses absolute and ../ names by default; the profile keeps every write in runDir.
    const extracted = await runSandboxed(context, profile, TAR_PATH, ['-xf', '-', '-C', runDir], {
      cwd: runDir,
      input: archive.stdout as NodeJS.ReadableStream,
      signal,
    });
    if ((await archived) !== 0 || extracted.code !== 0)
      throw new SandboxError('Baseline archive or extraction failed', 'workspace_process_failed', extracted.stderr);
    for (const args of [
      ['init', '--quiet'],
      ['config', 'user.name', 'TaskPilot Coding Agent'],
      ['config', 'user.email', 'taskpilot-coding-agent@localhost'],
      ['add', '-A', '--', '.'],
      ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'TaskPilot baseline'],
    ]) {
      const result = await runSandboxed(context, profile, GIT_PATH, [...GIT_SAFE, '-C', runDir, ...args], { cwd: runDir, signal });
      if (result.code !== 0) throw new SandboxError(`git ${args[0]} failed in the run directory`, 'workspace_process_failed', result.stderr);
    }
    return { runName: runDir, directory: runDir };
  } catch (error) {
    await clean(runDir, { context }).catch(() => {});
    throw error;
  }
};

// The agent's changes as a binary-safe patch, collected inside the sandbox.
export const diff = async (runName: string, { context, cli, signal }: { context: SandboxContext; cli: CliId; signal?: AbortSignal }): Promise<string> => {
  const runDir = runDirOf(context, runName);
  const profile = buildProfile(profileFor(context, cli, runDir, null));
  const staged = await runSandboxed(context, profile, GIT_PATH, [...GIT_SAFE, '-C', runDir, 'add', '-A', '--', '.'], { cwd: runDir, signal });
  if (staged.code !== 0) throw new SandboxError('Could not stage the run directory', 'workspace_process_failed', staged.stderr);
  const result = await runSandboxed(
    context,
    profile,
    GIT_PATH,
    [...GIT_SAFE, '-C', runDir, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', '--', '.'],
    {
      cwd: runDir,
      signal,
    },
  );
  if (result.code !== 0) throw new SandboxError('Could not read the run directory diff', 'workspace_process_failed', result.stderr);
  return result.stdout;
};

export const digestOf = (patch: string) => createHash('sha256').update(patch).digest('hex');

// fs.rm does not follow symlinks, so nothing outside the run directory goes.
export const clean = async (runName: string, { context }: { context: SandboxContext }): Promise<void> => {
  const runDir = runDirOf(context, runName);
  await fsp.rm(runDir, { recursive: true, force: true });
  await fsp.rm(agentHomeOf(runDir), { recursive: true, force: true });
};

// ========== CLI ==========

// The CLI's real path on the run's PATH, or null.
export const findCli = (cli: CliId, pathEntries: string[]): string | null => {
  for (const entry of pathEntries) {
    const candidate = path.join(entry, cli);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Not on this entry.
    }
  }
  return null;
};

// Headless arguments, matching scripts/taskpilot-coding-wrapper.sh except
// Codex: its own Seatbelt cannot start inside ours (verified 2026-10-14:
// "sandbox_apply: Operation not permitted"), so it runs unsandboxed inside
// TaskPilot's profile.
export const cliArgs = (config: AgentRuntimeConfig): string[] => {
  const { cli, model, thinking } = config;
  const withModel = (args: string[], flag = '--model') => (model ? [...args, flag, model] : args);
  switch (cli) {
    case 'codex': {
      const args = withModel(['exec', '--json', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--skip-git-repo-check']);
      return [...args, ...(thinking === 'default' ? [] : ['-c', `model_reasoning_effort=${thinking}`]), '-'];
    }
    case 'claude':
      return [
        ...withModel(['-p', '--output-format', 'stream-json', '--verbose', '--tools', 'Bash,Edit,Read,Write,Glob,Grep', '--strict-mcp-config']),
        ...(thinking === 'default' ? [] : ['--effort', thinking]),
      ];
    case 'pi':
      return [
        ...withModel([
          '--mode',
          'json',
          '--print',
          '--no-extensions',
          '--no-mcp',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-session',
        ]),
        ...(thinking === 'default' ? [] : ['--thinking', thinking]),
      ];
    case 'grok':
      return [
        ...withModel(['--output-format', 'streaming-messages-json', '--prompt-file', '/dev/stdin', '--disable-web-search', '--no-subagents']),
        ...(thinking === 'default' ? [] : ['--reasoning-effort', thinking]),
      ];
    case 'opencode':
      return [...withModel(['run', '--pure', '--format', 'json']), ...(thinking === 'default' ? [] : ['--variant', thinking])];
  }
};

// The spawn for one coding run, for coding_exec.ts to drive. The run's
// home must be seeded first (seedAgentHome).
export const runCommand = (
  context: SandboxContext,
  runName: string,
  config: AgentRuntimeConfig,
): { command: string; args: string[]; options: Record<string, unknown> } => {
  const runDir = runDirOf(context, runName);
  const executable = findCli(config.cli, context.pathEntries);
  if (!executable) throw new SandboxError(`${config.cli} CLI not found on PATH`, 'coding_spawn_failed');
  const profile = buildProfile(profileFor(context, config.cli, runDir, executable));
  return {
    command: SANDBOX_EXEC_PATH,
    args: sandboxArgs(profile, executable, cliArgs(config)),
    options: { cwd: runDir, env: sandboxEnv(context, processEnv(), agentHomeOf(runDir)), stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  };
};

// ========== Probe ==========

export type SandboxProbe = { available: boolean; version: string | null; reason: string | null };

// Checks the sandbox actually holds before reporting it usable: a file under
// home outside every allowed folder must be unreadable from inside, and the
// run directory writable. Failing closed is the point: Seatbelt is
// undocumented and could change under a macOS update.
export const probe = async (context: SandboxContext, config: AgentRuntimeConfig, { signal }: { signal?: AbortSignal } = {}): Promise<SandboxProbe> => {
  if (process.platform !== 'darwin') return { available: false, version: null, reason: 'sandbox: macOS only' };
  try {
    fs.accessSync(SANDBOX_EXEC_PATH, fs.constants.X_OK);
  } catch {
    return { available: false, version: null, reason: 'sandbox: sandbox-exec not found' };
  }
  const executable = findCli(config.cli, context.pathEntries);
  if (!executable) return { available: false, version: null, reason: `sandbox: ${config.cli} CLI not found on PATH` };
  if (!within(real(context.home), real(context.probeFile)) || !within(real(context.home), real(path.dirname(context.runRoot)))) {
    return { available: false, version: null, reason: 'sandbox: self-check failed (TaskPilot data is not under home)' };
  }
  const checkDir = path.join(context.runRoot, `probe-${randomUUID().slice(0, 8)}`);
  try {
    await fsp.mkdir(context.runRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(checkDir, { mode: 0o700 });
    await fsp.writeFile(context.probeFile, 'TaskPilot sandbox self-check. This file must not be readable from inside the sandbox.\n');
    const profile = buildProfile(profileFor(context, config.cli, checkDir, executable));
    const leaked = await runSandboxed(context, profile, '/bin/cat', [context.probeFile], { cwd: checkDir, timeoutMs: 15_000, signal });
    if (leaked.code === 0) return { available: false, version: null, reason: 'sandbox: self-check failed (a file outside the workspace was readable)' };
    const wrote = await runSandboxed(context, profile, '/usr/bin/touch', [path.join(checkDir, 'ok')], { cwd: checkDir, timeoutMs: 15_000, signal });
    if (wrote.code !== 0) return { available: false, version: null, reason: 'sandbox: self-check failed (the workspace was not writable)' };
    // The CLI's real state folder holds config its unsandboxed runs read.
    const planted = path.join(context.home, CLI_STATE_ROOT[config.cli], `taskpilot-probe-${randomUUID().slice(0, 8)}`);
    const plantedResult = await runSandboxed(context, profile, '/usr/bin/touch', [planted], { cwd: checkDir, timeoutMs: 15_000, signal });
    if (plantedResult.code === 0) {
      await fsp.rm(planted, { force: true });
      return { available: false, version: null, reason: "sandbox: self-check failed (the CLI's own config folder was writable)" };
    }
    const agentHome = await seedAgentHome(context, checkDir, config.cli);
    const version = await runSandboxed(context, profile, executable, ['--version'], { cwd: checkDir, timeoutMs: 30_000, signal, agentHome });
    const text = version.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (version.code !== 0 || !text) return { available: false, version: null, reason: `sandbox: ${config.cli} CLI did not start inside the sandbox` };
    return { available: true, version: text, reason: null };
  } catch (error) {
    return { available: false, version: null, reason: `sandbox: self-check failed (${(error as Error).message})` };
  } finally {
    await fsp.rm(checkDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(agentHomeOf(checkDir), { recursive: true, force: true }).catch(() => {});
  }
};

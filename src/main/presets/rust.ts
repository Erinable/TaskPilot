// The Rust preset: Cargo commands over the whole workspace, so a single
// crate, a root package with members and a virtual workspace all check every
// crate. Diagnostics come from Cargo's JSON messages, rustfmt's diff
// headers and libtest's results.
//
// SECURITY: every command is a fixed argument array. `cargo fetch` only
// downloads; build scripts and proc macros run in build, lint and test, as
// they do for any `cargo build` the developer runs.
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import * as git from '../git.ts';
import { readTracked } from '../repo_reader.ts';
import { semverOrNull } from '../../shared/semver.ts';
import { resolveExecutable } from '../workspace.ts';
import type { Preset } from './preset.ts';
import type { StepId, StepKind } from '../../shared/check_steps.ts';
import type { StepPatch } from '../step_config.ts';
import type { LooseJson } from '../loose_json.ts';

// The parts of the root Cargo.toml the preset reads.
export type CargoManifest = { valid: boolean; package: string | null; workspace: boolean };

// `nextest` is whether cargo-nextest is on the command PATH.
export type RustFacts = { manifest: CargoManifest | null; nextest: boolean };

export const parseCargoManifest = (content: string): CargoManifest => {
  let raw: LooseJson;
  try {
    raw = parseToml(content);
  } catch {
    return { valid: false, package: null, workspace: false };
  }
  const name = raw.package?.name;
  return { valid: true, package: typeof name === 'string' ? name.slice(0, 120) : null, workspace: Boolean(raw.workspace) };
};

// The root Cargo.toml's `[package].version`, else the workspace's
// `[workspace.package].version` (which members inherit with
// `version.workspace = true`); null when neither is semver.
const cargoVersion = (content: string | null) => {
  if (content === null) return null;
  let raw: LooseJson;
  try {
    raw = parseToml(content);
  } catch {
    return null;
  }
  return semverOrNull(raw.package?.version) ?? semverOrNull(raw.workspace?.package?.version);
};

// Rust builds are slow the first time; the default 10 minutes is not enough.
const SLOW_MS = 30 * 60 * 1000;

const cargo = (...args: string[]) => ({ command: 'cargo', args });

// Cargo's JSON messages: one compiler diagnostic per line, files relative
// to the workspace root.
const CARGO_JSON = { format: 'json', dialect: 'cargo', path: null } as const;

// `cargo fmt --check` prints `Diff in <absolute file>:<line>:` before each
// hunk it would change.
const RUSTFMT_DIFF = '^(?<message>Diff) in (?<file>.+?):(?<line>\\d+):$';

// nextest's libtest-json output is still experimental and must be opted
// into with this variable. --no-fail-fast runs every test, so a failure
// cannot hide the results after it from the baseline.
const NEXTEST = {
  commands: [cargo('nextest', 'run', '--workspace', '--no-fail-fast', '--message-format', 'libtest-json')],
  env: { NEXTEST_EXPERIMENTAL_LIBTEST_JSON: '1' },
};
const CARGO_TEST = { commands: [cargo('test', '--workspace', '--no-fail-fast')], env: {} };

export const rustPreset: Preset<RustFacts> = {
  id: 'rust',
  label: 'Rust',
  manifests: ['Cargo.toml'],
  testLayout: 'unit tests in a #[cfg(test)] mod tests inside the source file; integration tests in tests/*.rs',
  detect: (tracked) => tracked.has('Cargo.toml'),
  facts: async (root, { envPath } = {}) => {
    const { files } = await readTracked(root, ['Cargo.toml'], { maxFiles: 1, maxFileBytes: 64 * 1024, maxTotalBytes: 64 * 1024 });
    const nextest = (await resolveExecutable('cargo-nextest', { cwd: root, ...(envPath ? { envPath } : {}) })) !== null;
    return { manifest: files[0] ? parseCargoManifest(files[0].content) : null, nextest };
  },
  steps: ({ manifest, nextest }) => {
    if (!manifest?.valid) return {};
    const steps: Partial<Record<StepId, StepPatch>> = {
      setup: { commands: [cargo('fetch')], parser: { format: 'exitcode' }, timeoutMs: SLOW_MS },
      build: { commands: [cargo('build', '--workspace', '--message-format=json')], parser: CARGO_JSON, timeoutMs: SLOW_MS },
      format: { commands: [cargo('fmt', '--all', '--check')], parser: { format: 'regex', pattern: RUSTFMT_DIFF, severity: 'error' } },
      lint: { commands: [cargo('clippy', '--workspace', '--all-targets', '--message-format=json')], parser: CARGO_JSON, timeoutMs: SLOW_MS },
      test: { ...(nextest ? NEXTEST : CARGO_TEST), parser: { format: 'tests' }, timeoutMs: SLOW_MS },
    };
    return steps;
  },
  suggestions: (): Partial<Record<StepKind, string[]>> => ({
    setup: ['cargo fetch', 'cargo fetch --locked'],
    build: ['cargo build --workspace --message-format=json', 'cargo build --workspace --all-targets --message-format=json'],
    format: ['cargo fmt --all --check'],
    lint: ['cargo clippy --workspace --all-targets --message-format=json', 'cargo clippy --workspace --all-targets --message-format=json -- -D warnings'],
    typecheck: ['cargo check --workspace --all-targets --message-format=json'],
    test: ['cargo test --workspace --no-fail-fast', 'cargo test --workspace --no-fail-fast -- --include-ignored'],
  }),
  tools: [
    { command: 'cargo', versionArgs: ['--version'], install: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 或从 https://rustup.rs 安装" },
    {
      command: 'rustup',
      versionArgs: ['--version'],
      install: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 或从 https://rustup.rs 安装",
    },
    { command: 'cargo-clippy', versionArgs: ['--version'], install: 'rustup component add clippy' },
    { command: 'rustfmt', versionArgs: ['--version'], install: 'rustup component add rustfmt' },
  ],
  // libtest and nextest name a test by its module path inside the crate.
  testNameFormat:
    'the test function\'s module path inside its crate joined with "::", e.g. "auth::tests::locks_after_five_failures" for a #[test] fn in mod tests of src/auth.rs; a test in tests/login.rs is just its function name, e.g. "it_works"',
  // [人工决策-2026-10-25 23:51:35] Rust 仓库的清单、锁文件、构建脚本和 .cargo/ 改动要人工确认（CARM-16 #9）。
  // 这会让更多补丁停下等确认，与 work_package_status.ts 的全自动闭环决策不冲突：有确认项本来就停下等人。
  // Any crate's, not only the root's: a workspace has one per member.
  protectedFiles: [/(?:^|\/)(?:Cargo\.toml|Cargo\.lock|build\.rs)$/i, /(?:^|\/)\.cargo(?:\/|$)/i],
  secretFiles: [/(?:^|\/)\.cargo\/credentials(?:\.toml)?$/i],
  // Downloaded crates go in the run's home; the installed toolchain stays
  // where rustup put it, read-only.
  sandboxEnv: (agentHome, home) => ({ CARGO_HOME: path.join(agentHome, '.cargo'), RUSTUP_HOME: path.join(home, '.rustup') }),
  sandboxRead: (home) => [path.join(home, '.rustup')],
  version: async (root, commit) => ({ file: 'Cargo.toml', value: cargoVersion(await git.showFile(root, commit, 'Cargo.toml')) }),
};

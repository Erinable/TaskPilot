import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  CodingWorkspaceError,
  applyPatch,
  parsePatchPreview,
  prepare,
  readPatch,
  selectPatch,
  snapshotBaseline,
  type WorkspaceSpawnFn,
} from '../../src/main/coding_workspace.ts';
import { PRESETS, presetById } from '../../src/main/presets/index.ts';
import type { PatchRules } from '../../src/main/coding_workspace.ts';

const patch = (file: string): string =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+safe\n`;

test('parsePatchPreview rejects traversal and symlink modes', () => {
  const traversal = parsePatchPreview(patch('../escape.txt'));
  assert.equal(traversal.blocked[0]?.reason, 'path traversal');
  const symlink = parsePatchPreview(patch('link').replace('100644', '120000'));
  assert.equal(symlink.blocked[0]?.reason, 'symlink or submodule mode is not permitted');
});

test('parsePatchPreview classifies high-risk project files', () => {
  const preview = parsePatchPreview(patch('package.json'));
  assert.equal(preview.files[0]?.highRisk, true);
  assert.equal(preview.blocked[0]?.reason, 'high-risk project control or test path');
});

const rulesOf = (...ids: string[]): PatchRules => {
  const list = ids.map((id) => presetById(id)).filter((preset) => preset !== null);
  return { protectedFiles: list.flatMap((preset) => preset.protectedFiles), secretFiles: list.flatMap((preset) => preset.secretFiles) };
};
const reasons = (file: string, rules?: PatchRules) => parsePatchPreview(patch(file), undefined, rules).blocked.map((entry) => entry.reason);
const HIGH_RISK = 'high-risk project control or test path';

test('the Rust and Python presets mark their manifests, lockfiles and build scripts high-risk', () => {
  const protectedFiles: Record<string, string[]> = {
    rust: ['Cargo.toml', 'Cargo.lock', 'build.rs', 'crates/core/Cargo.toml', 'crates/core/build.rs', '.cargo/config.toml'],
    python: [
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'requirements-dev.txt',
      'requirements/base.txt',
      'conftest.py',
      'src/pkg/conftest.py',
      'tox.ini',
      'noxfile.py',
      'uv.lock',
    ],
  };
  for (const [id, files] of Object.entries(protectedFiles))
    for (const file of files) {
      const preview = parsePatchPreview(patch(file), undefined, rulesOf(id));
      assert.equal(preview.files[0]?.highRisk, true, `${id}: ${file}`);
      assert.ok(reasons(file, rulesOf(id)).includes(HIGH_RISK), `${id}: ${file}`);
    }
  // Only the repository's own languages add rules.
  for (const file of ['Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt', 'conftest.py']) assert.deepEqual(reasons(file), [], file);
  assert.deepEqual(reasons('pyproject.toml', rulesOf('rust')), []);
  for (const file of ['src/main.rs', 'src/lib.rs', 'src/pkg/module.py', 'docs/requirements.md', 'my_setup.py'])
    assert.deepEqual(reasons(file, rulesOf('rust', 'python')), [], file);
});

test('the Rust and Python presets block their credential files', () => {
  assert.ok(reasons('.pypirc', rulesOf('python')).includes('secret path'));
  assert.ok(reasons('.cargo/credentials', rulesOf('rust')).includes('secret path'));
  assert.ok(reasons('.cargo/credentials.toml', rulesOf('rust')).includes('secret path'));
  // .cargo/credentials* was already caught by the fixed rule; .pypirc was not.
  assert.deepEqual(reasons('.pypirc'), []);
});

test('the presets only add to the fixed rules', () => {
  const every = rulesOf(...PRESETS.map((preset) => preset.id));
  const files = ['package.json', 'taskpilot.toml', '.github/workflows/ci.yml', 'tests/a.test.ts', 'Makefile', '.env', 'id_rsa', 'src/a.ts', 'README.md'];
  for (const file of files) for (const reason of reasons(file)) assert.ok(reasons(file, every).includes(reason), `${file}: ${reason}`);
  assert.deepEqual(reasons('src/a.ts', every), []);
  assert.deepEqual(rulesOf('typescript'), { protectedFiles: [], secretFiles: [] });
});

test('applyPatch refuses a preset secret path even when high-risk files are allowed', async () => {
  const preview = parsePatchPreview(patch('.pypirc'), undefined, rulesOf('python'));
  await assert.rejects(
    applyPatch(os.tmpdir(), preview.patch, preview.digest, [], { rules: rulesOf('python') }),
    (error: unknown) => error instanceof CodingWorkspaceError && error.code === 'workspace_blocked_patch',
  );
});

test('readPatch uses the fixed wrapper action and validates scope', async () => {
  const calls: string[][] = [];
  const spawn: WorkspaceSpawnFn = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    const process = new (class extends PassThrough {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 123;
      kill(): boolean {
        return true;
      }
    })();
    queueMicrotask(() => {
      process.stdout.end(patch('src/a.ts'));
      process.emit('close', 0, null);
    });
    return process;
  }) as unknown as WorkspaceSpawnFn;
  const preview = await readPatch('/Users/taskpilot-coder/TaskPilotRuns/run-1', ['src/a.ts'], { spawnFn: spawn });
  assert.equal(preview.files[0]?.path, 'src/a.ts');
  assert.equal(preview.digest, createHash('sha256').update(preview.patch).digest('hex'));
  assert.equal(calls[0]?.[0], '/usr/bin/sudo');
  assert.equal(calls[0]?.at(-2), 'diff');
});

test('prepare sends git archive output only to wrapper extract', async () => {
  const calls: string[][] = [];
  let archiveBytes = 0;
  const spawn: WorkspaceSpawnFn = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    const process = new (class extends PassThrough {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 321;
      kill(): boolean {
        return true;
      }
    })();
    if (command === '/usr/bin/sudo' && args.includes('extract'))
      process.stdin.on('data', (chunk) => {
        archiveBytes += chunk.length;
      });
    queueMicrotask(() => {
      if (command === '/usr/bin/git') {
        process.stdout.end(Buffer.from('tar archive bytes'));
        process.emit('close', 0, null);
      } else {
        process.emit('close', 0, null);
      }
    });
    return process;
  }) as unknown as WorkspaceSpawnFn;
  const prepared = await prepare('/checkout', 'baseline', { runRoot: '/tmp/taskpilot-runs', spawnFn: spawn });
  assert.match(prepared.runName, /^\/tmp\/taskpilot-runs\/[A-Za-z0-9-]+$/);
  assert.equal(archiveBytes, 'tar archive bytes'.length);
  assert.equal(calls.find((call) => call[0] === '/usr/bin/git')?.at(-1), 'baseline');
});

test('invalid digest is represented by the stable workspace error', () => {
  const error = new CodingWorkspaceError('bad digest', 'workspace_digest_mismatch');
  assert.equal(error.code, 'workspace_digest_mismatch');
});

test('selectPatch keeps only the chosen files and rejects unknown ones', () => {
  const full = patch('src/a.ts') + patch('src/b.ts');
  const selected = selectPatch(full, ['src/b.ts']);
  assert.equal(selected, patch('src/b.ts'));
  assert.deepEqual(
    parsePatchPreview(selected).files.map((file) => file.path),
    ['src/b.ts'],
  );
  assert.throws(() => selectPatch(full, ['src/c.ts']), { code: 'workspace_invalid_patch' });
});

test('snapshotBaseline commits scoped working-tree files without touching the checkout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-snapshot-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    await fs.writeFile(path.join(root, 'other.txt'), 'o\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const baseline = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'a.txt'), 'changed\n');
    await fs.rm(path.join(root, 'b.txt'));
    await fs.writeFile(path.join(root, 'c.txt'), 'new\n');
    await fs.writeFile(path.join(root, 'other.txt'), 'out of scope\n');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
    const statusBefore = git('status', '--porcelain');

    const commit = await snapshotBaseline(root, baseline, ['a.txt', 'b.txt', 'c.txt', 'missing.txt', '.env']);

    assert.equal(git('rev-parse', `${commit}^`), baseline);
    assert.deepEqual(git('ls-tree', '--name-only', commit).split('\n'), ['a.txt', 'c.txt', 'other.txt']);
    assert.equal(git('show', `${commit}:a.txt`), 'changed');
    assert.equal(git('show', `${commit}:other.txt`), 'o');
    assert.equal(git('rev-parse', 'HEAD'), baseline);
    assert.equal(git('status', '--porcelain'), statusBefore);
    assert.equal(git('stash', 'list'), '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

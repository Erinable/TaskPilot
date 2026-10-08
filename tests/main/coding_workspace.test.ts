import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { CodingWorkspaceError, parsePatchPreview, prepare, readPatch, type WorkspaceSpawnFn } from '../../src/main/coding_workspace.ts';

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

import { expect, test } from 'vitest';

import { commandLabel, commandsSummary, fileLabel, transcriptBlocks } from '@/lib/coding_transcript.ts';
import type * as codingTypes from '@shared/coding_types.ts';

let sequence = 0;
const event = (overrides: Partial<codingTypes.CodingEvent>): codingTypes.CodingEvent => ({
  sequence: sequence++,
  at: '2026-11-10T14:03:45Z',
  type: 'tool',
  text: 'x',
  ...overrides,
});
const command = (id: string, status: 'running' | 'done' | 'failed', exitCode: number | null = null): codingTypes.CodingItem => ({
  id,
  kind: 'command',
  status,
  command: `/bin/zsh -lc 'npm test'`,
  exitCode,
  output: status === 'running' ? '' : 'ok',
  outputTruncated: false,
});

test('a command reported when it starts and when it ends is one row; consecutive commands share a group', () => {
  const blocks = transcriptBlocks([
    event({ type: 'text', text: '我先看看仓库。' }),
    event({ item: command('a', 'running') }),
    event({ item: command('a', 'done', 0) }),
    event({ item: command('b', 'running') }),
    event({ item: command('b', 'failed', 1) }),
    event({ type: 'text', text: '测试失败了。' }),
    event({ item: command('c', 'running') }),
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(['message', 'commands', 'message', 'commands']);
  const first = blocks[1];
  expect(first.kind === 'commands' && first.commands.map((entry) => [entry.id, entry.status])).toEqual([
    ['a', 'done'],
    ['b', 'failed'],
  ]);
});

test('a file edit is updated in place, and Codex warnings read as notices', () => {
  const files = (status: 'running' | 'done'): codingTypes.CodingItem => ({
    id: 'f',
    kind: 'files',
    status,
    files: [{ path: '/x/.gitignore', change: 'update' }],
  });
  const blocks = transcriptBlocks([
    event({ type: 'status', item: { id: 'w', kind: 'notice', message: 'Codex is ignoring 1 setting' } }),
    event({ item: files('running') }),
    event({ item: files('done') }),
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(['notice', 'files']);
  expect(blocks[1].kind === 'files' && blocks[1].item.status).toBe('done');
});

test('labels drop the shell wrapper and the run directory', () => {
  expect(commandLabel(`/bin/zsh -lc 'git status --short && cat package.json'`)).toBe('git status --short && cat package.json');
  expect(commandLabel(`/bin/zsh -lc "npm view expo version"`)).toBe('npm view expo version');
  expect(commandLabel('ls -la')).toBe('ls -la');
  expect(fileLabel('/Users/me/Library/Application Support/taskpilot/coding-runs/8a23/src/App.tsx')).toBe('src/App.tsx');
  expect(fileLabel('src/App.tsx')).toBe('src/App.tsx');
  expect(commandsSummary([command('a', 'done', 0), command('b', 'failed', 2)] as never)).toBe('运行了 2 条命令，1 条失败');
  expect(commandsSummary([command('a', 'done', 0), command('b', 'running')] as never)).toBe('正在运行命令（已完成 1 / 2）');
});

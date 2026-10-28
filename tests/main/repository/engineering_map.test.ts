import { test } from 'vitest';
import assert from 'node:assert/strict';

import { buildEngineeringMap, MAX_TREE_FILES } from '../../../src/main/repository/engineering_map.ts';
import type { Requirement } from '../../../src/main/requirements/requirement_store.ts';

const requirement = (
  id: string,
  updatedAt: string,
  modules: { path: string; purpose: string }[],
  read: { path: string; sha?: string }[],
  extra: { conventions?: string[]; gaps?: string[] } = {},
): Requirement =>
  ({
    id,
    status: 'reviewing',
    title: `需求 ${id}`,
    text: 't',
    summary: null,
    questions: [],
    plan: null,
    packages: [],
    phase: null,
    error: null,
    failedStep: null,
    costUsd: 0,
    createdAt: updatedAt,
    updatedAt,
    interfaces: {
      summary: {
        modules: modules.map((module) => ({ ...module, members: [], dependsOn: [], notes: [] })),
        conventions: extra.conventions ?? [],
        gaps: extra.gaps ?? [],
      },
      text: 'x',
      read,
      skipped: [],
      error: null,
    },
  }) as Requirement;

const index = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, sha]) => [path, { mode: '100644', sha }]));

test('the newest summary of a file wins and keeps its source', () => {
  const map = buildEngineeringMap(
    [
      requirement('new', '2026-10-06T00:00:00Z', [{ path: 'src/a.ts', purpose: '新' }], [{ path: 'src/a.ts', sha: 's2' }]),
      requirement(
        'old',
        '2026-10-01T00:00:00Z',
        [
          { path: 'src/a.ts', purpose: '旧' },
          { path: 'src/b.ts', purpose: 'B' },
        ],
        [
          { path: 'src/a.ts', sha: 's1' },
          { path: 'src/b.ts', sha: 'b1' },
        ],
      ),
    ],
    index({ 'src/a.ts': 's2', 'src/b.ts': 'b1' }),
    ['src/a.ts', 'src/b.ts'],
  );
  assert.deepEqual(
    map.modules.map((module) => [module.path, module.purpose, module.source.requirementId]),
    [
      ['src/a.ts', '新', 'new'],
      ['src/b.ts', 'B', 'old'],
    ],
  );
});

test('freshness compares the blob Architect read with the current index', () => {
  const map = buildEngineeringMap(
    [
      requirement(
        'r',
        '2026-10-06T00:00:00Z',
        [
          { path: 'same.ts', purpose: '' },
          { path: 'changed.ts', purpose: '' },
          { path: 'gone.ts', purpose: '' },
          { path: 'unrecorded.ts', purpose: '' },
        ],
        [
          { path: 'same.ts', sha: 'a' },
          { path: 'changed.ts', sha: 'b' },
          { path: 'gone.ts', sha: 'c' },
        ],
      ),
    ],
    index({ 'same.ts': 'a', 'changed.ts': 'b2', 'unrecorded.ts': 'd' }),
    [],
  );
  assert.deepEqual(Object.fromEntries(map.modules.map((module) => [module.path, module.freshness])), {
    'changed.ts': 'stale',
    'gone.ts': 'removed',
    'same.ts': 'current',
    'unrecorded.ts': 'unknown',
  });
});

test('without a workspace every module is of unknown freshness', () => {
  const map = buildEngineeringMap([requirement('r', '2026-10-06T00:00:00Z', [{ path: 'a.ts', purpose: '' }], [{ path: 'a.ts', sha: 'a' }])], null, []);
  assert.equal(map.modules[0].freshness, 'unknown');
  assert.deepEqual(map.files, []);
});

test('conventions and gaps are de-duplicated and requirements without a summary are skipped', () => {
  const failed = {
    ...requirement('f', '2026-10-07T00:00:00Z', [], []),
    interfaces: { summary: null, text: null, read: [], skipped: [], error: { code: 'agent_timeout', message: 'x' } },
  } as Requirement;
  const map = buildEngineeringMap(
    [
      requirement('a', '2026-10-01T00:00:00Z', [], [], { conventions: ['测试放在 tests/'], gaps: ['没有 lint'] }),
      requirement('b', '2026-10-02T00:00:00Z', [], [], { conventions: ['测试放在 tests/'] }),
      failed,
      { ...requirement('n', '2026-10-03T00:00:00Z', [], []), interfaces: null } as Requirement,
    ],
    null,
    [],
  );
  assert.deepEqual(
    map.conventions.map((note) => [note.text, note.source.requirementId]),
    [['测试放在 tests/', 'b']],
  );
  assert.deepEqual(
    map.gaps.map((note) => note.text),
    ['没有 lint'],
  );
  assert.equal(map.modules.length, 0);
});

test('the file tree is capped and says so', () => {
  const paths = Array.from({ length: MAX_TREE_FILES + 1 }, (_unused, index) => `f${index}.ts`);
  const map = buildEngineeringMap([], null, paths);
  assert.equal(map.files.length, MAX_TREE_FILES);
  assert.equal(map.truncated, true);
});

import { describe, expect, test } from 'vitest';

import { buildMapTree, summarizedOnly } from '../../src/renderer/src/lib/map_tree.ts';

const paths = ['src/main/ipc.ts', 'README.md', 'src/main/agents/qa.ts', 'src/a.ts', 'package.json', 'tests/ipc.test.ts'];

describe('buildMapTree', () => {
  test('sorts directories before files, both by name', () => {
    const tree = buildMapTree(paths, new Set());
    expect(tree.map((node) => node.name)).toEqual(['src', 'tests', 'package.json', 'README.md']);
    const src = tree[0];
    expect(src.children.map((node) => node.name)).toEqual(['main', 'a.ts']);
    expect(src.children[0].children.map((node) => node.name)).toEqual(['agents', 'ipc.ts']);
  });

  test('nests with full paths and counts files and summaries per directory', () => {
    const tree = buildMapTree(paths, new Set(['src/main/ipc.ts', 'src/main/agents/qa.ts']));
    const src = tree[0];
    expect(src).toMatchObject({ path: 'src', isDir: true, fileCount: 3, summarizedCount: 2 });
    const main = src.children[0];
    expect(main).toMatchObject({ path: 'src/main', fileCount: 2, summarizedCount: 2 });
    expect(main.children[0]).toMatchObject({ path: 'src/main/agents', fileCount: 1, summarizedCount: 1 });
    expect(main.children[1]).toMatchObject({ path: 'src/main/ipc.ts', isDir: false, summarized: true });
    expect(src.children[1]).toMatchObject({ path: 'src/a.ts', summarized: false });
    expect(tree[1]).toMatchObject({ path: 'tests', fileCount: 1, summarizedCount: 0 });
  });

  test('an empty list is an empty tree', () => {
    expect(buildMapTree([], new Set())).toEqual([]);
  });
});

describe('summarizedOnly', () => {
  test('keeps summarized files and their directories, with whole-directory counts', () => {
    const tree = summarizedOnly(buildMapTree(paths, new Set(['src/main/ipc.ts'])));
    expect(tree.map((node) => node.path)).toEqual(['src']);
    expect(tree[0]).toMatchObject({ fileCount: 3, summarizedCount: 1 });
    expect(tree[0].children.map((node) => node.path)).toEqual(['src/main']);
    expect(tree[0].children[0].children.map((node) => node.path)).toEqual(['src/main/ipc.ts']);
  });
});

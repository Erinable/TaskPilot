import { describe, expect, test } from 'vitest';

import * as search from '../../src/renderer/src/lib/search.ts';
import { taskView } from './execution_fakes.ts';
import { requirement } from './requirements_fakes.ts';

const settings = [
  search.settingEntry({ page: 'profile', label: '个人资料', keywords: '名字 头像 avatar' }),
  search.settingEntry({ page: 'commands', label: '验证命令', keywords: '命令 测试 lint' }),
];

const keys = (groups: search.SearchGroup[]) => groups.map((group) => [group.label, group.entries.map((entry) => entry.key)]);

describe('search', () => {
  test('groups by kind in a fixed order and drops empty groups', () => {
    const entries = [
      ...settings,
      search.requirementEntry(requirement({ id: 'r1', title: '邮箱登录' }), '待回答'),
      search.taskEntry(taskView({ id: 't1', title: '登录接口' })),
    ];
    expect(keys(search.search(entries, '登录'))).toEqual([['工作包', ['task:t1']], ['需求', ['requirement:r1']]]);
  });

  test('is case-insensitive and requires every term to match somewhere', () => {
    const entries = [
      search.taskEntry(taskView({ id: 't1', title: 'Login API', module: 'auth', tags: [], description: 'email flow' })),
      search.taskEntry(taskView({ id: 't2', title: 'Login page', module: 'web', tags: [], description: 'form' })),
    ];
    expect(keys(search.search(entries, 'LOGIN auth'))).toEqual([['工作包', ['task:t1']]]);
    expect(keys(search.search(entries, 'login EMAIL'))).toEqual([['工作包', ['task:t1']]]);
    expect(search.search(entries, 'login missing')).toEqual([]);
  });

  test('title beats id/module/tags beats description, and title prefixes rank first', () => {
    const entries = [
      search.taskEntry(taskView({ id: 'body', title: 'other', module: 'x', tags: [], description: 'cache layer' })),
      search.taskEntry(taskView({ id: 'meta', title: 'other', module: 'cache', tags: [], description: '' })),
      search.taskEntry(taskView({ id: 'inner', title: 'warm cache', module: 'x', tags: [], description: '' })),
      search.taskEntry(taskView({ id: 'prefix', title: 'cache warmup', module: 'x', tags: [], description: '' })),
    ];
    expect(search.search(entries, 'cache')[0].entries.map((entry) => entry.target)).toEqual([
      { kind: 'task', id: 'prefix' }, { kind: 'task', id: 'inner' }, { kind: 'task', id: 'meta' }, { kind: 'task', id: 'body' },
    ]);
  });

  test('tags, ids and settings keywords are searchable', () => {
    const entries = [search.taskEntry(taskView({ id: 'wp-42', title: 'x', tags: ['payments'] })), ...settings];
    expect(keys(search.search(entries, 'payments'))).toEqual([['工作包', ['task:wp-42']]]);
    expect(keys(search.search(entries, 'WP-42'))).toEqual([['工作包', ['task:wp-42']]]);
    expect(keys(search.search(entries, '头像'))).toEqual([['设置', ['setting:profile']]]);
  });

  test('caps each group at eight', () => {
    const entries = Array.from({ length: 12 }, (_, index) => search.taskEntry(taskView({ id: `t${index}`, title: `任务 ${index}` })));
    expect(search.search(entries, '任务')[0].entries).toHaveLength(search.GROUP_LIMIT);
  });

  test('an empty query shows open packages and requirements needing attention', () => {
    const entries = [
      search.taskEntry(taskView({ id: 'done', status: 'done' })),
      search.taskEntry(taskView({ id: 'open', status: 'pending' })),
      search.requirementEntry(requirement({ id: 'quiet', status: 'published' }), '已发布'),
      search.requirementEntry(requirement({ id: 'waiting', status: 'answering' }), '待回答'),
      ...settings,
    ];
    expect(keys(search.search(entries, '   '))).toEqual([['工作包', ['task:open']], ['需求', ['requirement:waiting']]]);
  });

  test('an untitled requirement is named by its first line', () => {
    expect(search.requirementEntry(requirement({ title: ' ', text: '第一行\n第二行' }), '草稿').title).toBe('第一行');
  });

  test('moveHighlight wraps and starts from the ends', () => {
    expect(search.moveHighlight(-1, 1, 3)).toBe(0);
    expect(search.moveHighlight(-1, -1, 3)).toBe(2);
    expect(search.moveHighlight(2, 1, 3)).toBe(0);
    expect(search.moveHighlight(0, -1, 3)).toBe(2);
    expect(search.moveHighlight(0, 1, 0)).toBe(-1);
  });
});

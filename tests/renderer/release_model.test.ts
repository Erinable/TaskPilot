// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import * as model from '../../src/renderer/src/lib/release_model.ts';
import * as fakes from './release_fakes.ts';

describe('release model', () => {
  test('start point line carries counts once a draft has them', () => {
    const startPoint = { kind: 'tag' as const, commit: 'abc', label: 'v1.2.0' };
    expect(model.startPointLine(startPoint, null)).toBe('从标签 v1.2.0 开始');
    expect(model.startPointLine({ ...startPoint, commitCount: 12, commitsTruncated: false, packageCount: 3 }, null)).toBe('从标签 v1.2.0 开始（12 个提交，3 个完成的工作包）');
    expect(model.startPointLine({ ...startPoint, kind: 'release' }, { commitCount: 200, commitsTruncated: true, fileCount: 1, filesTruncated: false, packageIds: ['p1'] }))
      .toBe('从上次发布 v1.2.0 开始（200+ 个提交，1 个完成的工作包）');
  });

  test('times follow the business time zone', () => {
    expect(model.formatTime('2026-09-30T16:30:00.000Z', 'Asia/Shanghai')).toBe('2026-10-01 00:30:00');
    expect(model.commitOptionLabel({ sha: 'c0ffee1234', subject: '初始提交', date: '2026-09-30T16:30:00.000Z' })).toBe('c0ffee1 初始提交 · 2026-10-01');
  });

  test('checked toggling and completion', () => {
    expect(model.toggleChecked([2, 0], 1, true)).toEqual([0, 1, 2]);
    expect(model.toggleChecked([0, 1], 1, false)).toEqual([0]);
    expect(model.allChecked(fakes.draft({ checked: [0] }))).toBe(false);
    expect(model.allChecked(fakes.draft({ checked: [1, 0] }))).toBe(true);
    expect(model.allChecked(fakes.draft({ plan: null }))).toBe(false);
  });

  test('version wording', () => {
    expect(model.versionFrom(fakes.plan({ currentVersion: null }))).toBe('未发布');
    expect(model.isMarkdownPath('docs/CHANGELOG.MD')).toBe(true);
    expect(model.isMarkdownPath('CHANGELOG.txt')).toBe(false);
  });
});

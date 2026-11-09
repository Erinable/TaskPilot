import { expect, test } from 'vitest';

import { gradeDimensions, independenceLines, qualityLines } from '../../../src/renderer/src/lib/grade_scores.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';

const scores = (signals: Partial<packageTypes.GradeScores['signals']> = {}): packageTypes.GradeScores => ({
  quality: 0,
  independence: 100,
  signals: {
    tests: { passed: 0, total: 0, points: 0 },
    qa: { passed: false, points: 0 },
    rubric: { points: 0 },
    hints: [],
    reference: { beforePass: false, deduction: 0 },
    similarity: { ratio: 0, deduction: 0 },
    ...signals,
  },
});

test('quality lines say when there was nothing to run', () => {
  expect(qualityLines(scores()).map((line) => line.value)).toEqual(['没有可运行的测试，0/40 分', '未通过，0/20 分', '0/40 分']);
});

test('independence lines list only deductions, or say there were none', () => {
  expect(independenceLines(scores())).toEqual([{ label: '没有扣分', value: '−0' }]);
  expect(
    independenceLines(
      scores({
        hints: [
          { level: 1, deduction: 0 },
          { level: 5, deduction: 20 },
        ],
      }),
    ),
  ).toEqual([{ label: '用了 L5 提示', value: '−20' }]);
});

test('dimension rows follow rubric order and keep levels even when there are no comments', () => {
  const comment: packageTypes.GradeComment = { category: 'a', observation: '边界条件漏了', betterWay: '补上空输入', file: null, line: null, repeated: false };
  const report = { summary: '', strengths: [], comments: [comment], levels: { b: 2 } };
  expect(
    gradeDimensions(report, [
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A' },
      { id: 'c', label: 'C' },
    ]),
  ).toEqual([
    { id: 'b', label: 'B', level: 2, comments: [] },
    { id: 'a', label: 'A', level: null, comments: [comment] },
  ]);
  expect(gradeDimensions({ summary: '', strengths: [], comments: [] }, [{ id: 'a', label: 'A' }])).toEqual([]);
});

test('older reports without levels still show their comments and preserve their order', () => {
  const comment: packageTypes.GradeComment = {
    category: 'a',
    observation: '遗漏错误处理',
    betterWay: '显式处理返回值',
    file: null,
    line: null,
    repeated: false,
  };
  expect(gradeDimensions({ summary: '', strengths: [], comments: [comment, { ...comment, observation: '命名含糊' }] }, [{ id: 'a', label: 'A' }])).toEqual([
    { id: 'a', label: 'A', level: null, comments: [comment, { ...comment, observation: '命名含糊' }] },
  ]);
});

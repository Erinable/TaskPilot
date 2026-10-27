import { expect, test } from 'vitest';

import { independenceLines, qualityLines, rubricLevels } from '../../src/renderer/src/lib/grade_scores.ts';
import type * as packageTypes from '../../src/shared/ipc/packages.ts';

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

test('rubric levels follow the rubric order and skip items without one', () => {
  const report = { summary: '', strengths: [], comments: [], levels: { b: 2 } };
  expect(
    rubricLevels(report, [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]),
  ).toEqual([{ label: 'B', value: '2/4 级' }]);
  expect(rubricLevels({ summary: '', strengths: [], comments: [] }, [{ id: 'a', label: 'A' }])).toEqual([]);
});

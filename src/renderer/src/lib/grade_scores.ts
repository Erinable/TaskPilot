// A grade's two scores as the practice panel shows them: each line of the
// breakdown, so a score is never read without where its points came from.
// The scores themselves are worked out by the main process.
import type * as packageTypes from '@shared/ipc/packages.ts';

export type ScoreLine = { label: string; value: string };

export const qualityLines = ({ signals }: packageTypes.GradeScores): (ScoreLine & { id: string; points: number; maximum: number })[] => [
  {
    id: 'tests',
    label: '测试和验收',
    value: signals.tests.total ? `${signals.tests.passed}/${signals.tests.total} 通过，${signals.tests.points}/40 分` : '没有可运行的测试，0/40 分',
    points: signals.tests.points,
    maximum: 40,
  },
  {
    id: 'qa',
    label: 'QA 结论',
    value: signals.qa.passed ? `通过，${signals.qa.points}/20 分` : `未通过，${signals.qa.points}/20 分`,
    points: signals.qa.points,
    maximum: 20,
  },
  { id: 'rubric', label: '评分维度', value: `${signals.rubric.points}/40 分`, points: signals.rubric.points, maximum: 40 },
];

// Only what was deducted, then a line saying nothing was when nothing was.
export const independenceLines = ({ signals }: packageTypes.GradeScores): ScoreLine[] => {
  const lines: ScoreLine[] = signals.hints
    .filter((hint) => hint.deduction > 0)
    .map((hint) => ({ label: `用了 L${hint.level} 提示`, value: `−${hint.deduction}` }));
  if (signals.reference.beforePass) lines.push({ label: '测试全过之前看了参考答案', value: `−${signals.reference.deduction}` });
  if (signals.similarity.deduction > 0)
    lines.push({ label: `和看过的代码雷同 ${Math.round(signals.similarity.ratio * 100)}%`, value: `−${signals.similarity.deduction}` });
  return lines.length ? lines : [{ label: '没有扣分', value: '−0' }];
};

// Each dimension keeps its recorded level next to the comments it explains.
// Older reports without levels still show every comment in rubric order.
export const gradeDimensions = (report: packageTypes.GradeReport, rubric: { id: string; label: string }[]) =>
  rubric
    .map((item) => ({ ...item, level: report.levels?.[item.id] ?? null, comments: report.comments.filter((comment) => comment.category === item.id) }))
    .filter((item) => item.level !== null || item.comments.length > 0);

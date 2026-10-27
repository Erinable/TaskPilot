// The hint ladder: Tutor's help on one step comes in five levels, opened one
// at a time, each a step closer to the answer.
//   L1 what the step is about and the mechanism behind it, no code
//   L2 questions that lead to the key idea, no code
//   L3 the steps of the idea or pseudocode in words, no code
//   L4 where the failing public tests go wrong, at most 3 lines of code
//   L5 a code fragment of at most 10 lines, never the reference's own
// The lab generator writes a fallback ladder of the same shape (hints.json).

export const MAX_HINT_LEVEL = 5;
export const HINT_LEVELS = [1, 2, 3, 4, 5] as const;
// Lines of code a hint may carry, by level.
export const HINT_CODE_LINES: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 3, 5: 10 };

export const isHintLevel = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_HINT_LEVEL;

// One level opened at one step of a package, kept in the package's state.
// `filtered`: the output filter removed code from it (over the level's line
// cap, or too close to the reference solution).
// [人工决策-2026-10-27 00:51:12] 独立完成度按这里的记录扣分：L3 扣 5、L4 扣 10、L5 扣 20（T10 计算）；
// 用到 L5 即「提示梯度用完」，参考答案解锁（../main/practice.ts referenceLock）。
export type HintUse = { stepIndex: number; level: number; at: string; filtered: boolean };

// The highest level opened at `stepIndex`, or anywhere with no step; 0 for none.
export const openedLevel = (hints: HintUse[], stepIndex?: number): number =>
  hints.reduce((highest, use) => (stepIndex === undefined || use.stepIndex === stepIndex ? Math.max(highest, use.level) : highest), 0);

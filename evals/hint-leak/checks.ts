// What the hint leak eval measures: for each answer, whether the output
// filter (src/main/hint_leak.ts, after validateAnswer in
// src/main/agents/tutor.ts) refuses it, and across answers the filter's
// recall on leaks and its false refusals of honest hints. Whether an answer
// leaks is its label: true for the leaks written on purpose, and for
// Tutor's own answers what a separate labelling call decided.
import * as hintLeak from '../../src/main/hint_leak.ts';
import * as tutor from '../../src/main/agents/tutor.ts';
import type { CheckResult } from '../shared/harness.ts';

// How a leak gives the reference away (the issue's three shapes).
export const LEAK_STYLES = ['direct', 'renamed', 'split'] as const;
type LeakStyle = (typeof LEAK_STYLES)[number];

// `kind`: a hint Tutor wrote at L4 or L5 with the app's prompt, or a leak
// written on purpose in one style. `leak` and `reason`: the label. `filter` is checkLeak on the answer
// as the model wrote it; `blocked` is the whole output filter as the app
// runs it: validateAnswer and the level's line cap, then checkLeak on what
// is left. `invalid` is why validateAnswer refused the answer outright (the
// app shows nothing then); such an answer is left out of the rates.
export type Verdict = {
  kind: 'tutor' | LeakStyle;
  leak: boolean;
  reason: string | null;
  level: number;
  stepIndex: number | null;
  filter: hintLeak.LeakVerdict;
  capped: boolean;
  blocked: boolean;
  invalid: string | null;
  answer: tutor.TutorAnswer;
};

export const judge = (raw: tutor.TutorAnswer, level: number, reference: hintLeak.LeakReference): Omit<Verdict, 'kind' | 'leak' | 'reason' | 'stepIndex'> => {
  const filter = hintLeak.checkLeak(hintLeak.codeOf(raw), reference);
  let validated: ReturnType<typeof tutor.validateAnswer>;
  try {
    validated = tutor.validateAnswer(raw, level);
  } catch (error) {
    if ((error as { code?: string }).code !== 'agent_bad_output') throw error;
    return { level, filter, capped: false, blocked: true, invalid: (error as Error).message, answer: raw };
  }
  const { answer, filtered } = validated;
  const capped = filtered && raw.snippet !== null && answer.snippet === null;
  return { level, filter, capped, blocked: capped || hintLeak.checkLeak(hintLeak.codeOf(answer), reference).leaked, invalid: null, answer: raw };
};

const describe = (verdict: Verdict) =>
  `${verdict.kind}${verdict.stepIndex === null ? '' : ` step ${verdict.stepIndex + 1}`} L${verdict.level}: run=${verdict.filter.run} overlap=${verdict.filter.overlap.toFixed(2)}${verdict.capped ? ' capped' : ''}`;

// Per case: every leak is refused by checkLeak, and no honest hint is.
export const check = (all: Verdict[]): Record<string, CheckResult> => {
  const verdicts = all.filter((verdict) => !verdict.invalid);
  const leaks = verdicts.filter((verdict) => verdict.leak);
  const honest = verdicts.filter((verdict) => !verdict.leak);
  const missed = leaks.filter((verdict) => !verdict.filter.leaked);
  const refused = honest.filter((verdict) => verdict.filter.leaked);
  return {
    leaksCaught: { pass: !missed.length, detail: missed.length ? `missed ${missed.map(describe).join('; ')}` : `${leaks.length}/${leaks.length}` },
    honestKept: { pass: !refused.length, detail: refused.length ? `refused ${refused.map(describe).join('; ')}` : `${honest.length}/${honest.length}` },
  };
};

const rate = (count: number, total: number) => (total ? Math.round((count / total) * 1000) / 10 : null);

// Candidate thresholds for hint_leak.ts, rescored from each answer's run and
// overlap: `run R / overlap O` refuses an answer with a run of at least R
// lines or more than O of its 5-grams in the reference. The first is the
// shipped pair (LEAK_MIN_RUN 3, LEAK_MAX_OVERLAP 0.3).
const SWEEP = [3, 4].flatMap((minRun) => [0.3, 0.4, 0.5, 0.6, 0.7].map((maxOverlap) => ({ minRun, maxOverlap })));

const sweep = (leaks: Verdict[], honest: Verdict[]) =>
  Object.fromEntries(
    SWEEP.map(({ minRun, maxOverlap }) => {
      const refuses = (verdict: Verdict) => verdict.filter.run >= minRun || verdict.filter.overlap > maxOverlap;
      return [
        `run ${minRun} / overlap ${maxOverlap}`,
        { recall: rate(leaks.filter(refuses).length, leaks.length), falseRefusal: rate(honest.filter(refuses).length, honest.length) },
      ];
    }),
  );

// Recall and false refusals over every valid answer, by where the leak came
// from and by level; `pipeline` counts what the whole output filter blocks,
// line cap included. `tutorLeakRate`: the share of Tutor's own answers
// labelled as leaks, which is what the filter is there for.
export const summarizeVerdicts = (all: Verdict[]) => {
  const verdicts = all.filter((verdict) => !verdict.invalid);
  const leaks = verdicts.filter((verdict) => verdict.leak);
  const honest = verdicts.filter((verdict) => !verdict.leak);
  const tutor = verdicts.filter((verdict) => verdict.kind === 'tutor');
  const caught = (list: Verdict[]) => list.filter((verdict) => verdict.filter.leaked).length;
  return {
    recall: rate(caught(leaks), leaks.length),
    falseRefusal: rate(caught(honest), honest.length),
    leaks: `${caught(leaks)}/${leaks.length}`,
    honestRefused: `${caught(honest)}/${honest.length}`,
    tutorLeakRate: rate(tutor.filter((verdict) => verdict.leak).length, tutor.length),
    recallByStyle: Object.fromEntries(
      [...LEAK_STYLES, 'tutor' as const].map((style) => {
        const list = leaks.filter((verdict) => verdict.kind === style);
        return [style, `${caught(list)}/${list.length}`];
      }),
    ),
    falseRefusalByLevel: Object.fromEntries(
      [4, 5].map((level) => {
        const list = honest.filter((verdict) => verdict.level === level);
        return [`L${level}`, `${caught(list)}/${list.length}`];
      }),
    ),
    pipelineRecall: rate(leaks.filter((verdict) => verdict.blocked).length, leaks.length),
    pipelineFalseRefusal: rate(honest.filter((verdict) => verdict.blocked).length, honest.length),
    sweep: sweep(leaks, honest),
    invalid: all.filter((verdict) => verdict.invalid).map((verdict) => `${verdict.kind} L${verdict.level}: ${verdict.invalid}`),
  };
};

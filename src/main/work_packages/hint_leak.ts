// The hint ladder's output filter: whether Tutor's code gives away the
// reference solution. Prompts alone leak answers, so TaskPilot compares what
// Tutor wrote (the snippet and the code in its text) with the lines the
// reference patch adds, after normalising both: comments and whitespace go,
// strings become one token, and identifiers are numbered by first use
// within each line or 5-gram (`a = a + b` and `x = x + y` are the same), so
// renaming or reformatting the reference does not hide it, while code that
// only shares the language's shapes does not match.
//
// A leak is a run of LEAK_MIN_RUN consecutive meaningful lines equal to
// consecutive reference lines, or more than LEAK_MAX_OVERLAP of the code's
// token 5-grams found in the reference. The thresholds are calibrated on
// tests/fixtures/hint_leak.ts (recall at least 90%, at most 10% of honest
// hints refused); change them only together with that set.
import type { TutorAnswer } from '../agents/tutor.ts';

const LEAK_MIN_RUN = 3;
const LEAK_GRAM = 5;
const LEAK_MAX_OVERLAP = 0.3;
// A line with fewer tokens (a lone brace, `} else {`) says nothing; it is
// skipped on both sides so it neither makes nor breaks a run.
const MIN_LINE_TOKENS = 3;
// Code with fewer 5-grams is too short for the overlap to mean anything.
const MIN_GRAMS = 12;

// Kept as themselves: changing them changes the program, not a name.
const KEYWORDS = new Set(
  (
    'if else for while do switch case default break continue return goto sizeof typedef struct union enum static const extern volatile ' +
    'void int char long short unsigned signed float double bool true false null NULL nullptr ' +
    'let var function class new this super extends implements interface type import export from as async await yield throw try catch finally ' +
    'typeof instanceof in of delete undefined def elif lambda pass raise with is not and or None True False self ' +
    'func go defer chan select range map package fn mut impl pub use match loop then fi done esac'
  ).split(' '),
);

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|==+|!=+|<=|>=|&&|\|\||->|=>|\+\+|--|<<|>>|[^\s\w]/g;

// Comments out: /* */ (across lines), // to the end of a line, and # followed
// by a space (shell, Python), which leaves C's #include and #define alone.
const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '')
    .replace(/(^|\s)#(?=\s|$).*$/gm, '$1');

const IDENTIFIER = '\u0000';

const canonical = (token: string) => {
  if (/^[A-Za-z_$]/.test(token)) return KEYWORDS.has(token) ? token : IDENTIFIER + token;
  if (/^["'`]/.test(token)) return 'S';
  return token;
};

const tokensOf = (line: string) => (line.match(TOKEN) ?? []).map(canonical);

// Identifiers renamed by first use: the first becomes I0, the next new one I1.
const numbered = (tokens: string[]): string => {
  const names = new Map<string, string>();
  return tokens
    .map((token) => {
      if (!token.startsWith(IDENTIFIER)) return token;
      if (!names.has(token)) names.set(token, `I${names.size}`);
      return names.get(token);
    })
    .join(' ');
};

// The meaningful lines of a piece of code, each as its normalised tokens.
const normalisedLines = (code: string): string[] =>
  stripComments(code)
    .split('\n')
    .map(tokensOf)
    .filter((tokens) => tokens.length >= MIN_LINE_TOKENS)
    .map(numbered);

const gramsOf = (code: string): Set<string> => {
  const tokens = tokensOf(stripComments(code).replace(/\n/g, ' '));
  const grams = new Set<string>();
  for (let index = 0; index + LEAK_GRAM <= tokens.length; index += 1) grams.add(numbered(tokens.slice(index, index + LEAK_GRAM)));
  return grams;
};

// The lines a unified diff adds, without the +++ file headers.
export const addedLines = (patch: string): string =>
  patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

// The code inside Tutor's text: fenced blocks and `inline` spans.
export const codeInText = (text: string): string[] => [
  ...[...text.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)].map((match) => match[1]),
  ...[...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]),
];

// Every piece of code in an answer: the snippet and the code quoted in its text.
export const codeOf = (answer: TutorAnswer): string[] => [
  ...(answer.snippet ? [answer.snippet.code] : []),
  ...[answer.explanation, ...answer.hints, ...answer.terms.map((term) => term.meaning)].flatMap(codeInText),
];

// The reference, prepared once per answer.
export type LeakReference = { lines: string[]; grams: Set<string> };

export const prepareReference = (patch: string): LeakReference => {
  const added = addedLines(patch);
  return { lines: normalisedLines(added), grams: gramsOf(added) };
};

// Calls `visit(lineIndex, length)` for each line of `lines` that ends a run
// of consecutive lines equal to consecutive reference lines.
const eachRun = (lines: string[], reference: string[], visit: (lineIndex: number, length: number) => void) => {
  let previous = new Array<number>(reference.length + 1).fill(0);
  for (const [lineIndex, line] of lines.entries()) {
    const current = new Array<number>(reference.length + 1).fill(0);
    for (let index = 0; index < reference.length; index += 1) {
      if (reference[index] !== line) continue;
      current[index + 1] = previous[index] + 1;
      visit(lineIndex, current[index + 1]);
    }
    previous = current;
  }
};

// The longest run of consecutive lines of `lines` equal to consecutive reference lines.
const longestRun = (lines: string[], reference: string[]): number => {
  let best = 0;
  eachRun(lines, reference, (_lineIndex, length) => {
    if (length > best) best = length;
  });
  return best;
};

export type LeakVerdict = { leaked: boolean; run: number; overlap: number };

// `pieces`: every piece of code in one answer. Each is compared on its own
// for runs; their 5-grams are pooled, so a reference cut into several small
// pieces still adds up.
export const checkLeak = (pieces: string[], reference: LeakReference): LeakVerdict => {
  const run = Math.max(0, ...pieces.map((piece) => longestRun(normalisedLines(piece), reference.lines)));
  const grams = new Set(pieces.flatMap((piece) => [...gramsOf(piece)]));
  const shared = [...grams].filter((gram) => reference.grams.has(gram)).length;
  const overlap = grams.size >= MIN_GRAMS ? shared / grams.size : 0;
  return { leaked: run >= LEAK_MIN_RUN || overlap > LEAK_MAX_OVERLAP, run, overlap };
};

// How much of the developer's code (`code`, the lines their change adds)
// was taken from code TaskPilot showed them (`shown`: Tutor's snippets, the
// reference's added lines), 0 to 1: the share of its meaningful lines that
// sit in a run of LEAK_MIN_RUN or more lines equal to consecutive lines of
// one piece, with the same normalisation as the leak check. A single common
// line (`return x;`) never counts on its own.
export const copiedShare = (code: string, shown: string[]): number => {
  const lines = normalisedLines(code);
  if (!lines.length) return 0;
  const copied = new Set<number>();
  for (const piece of shown) {
    eachRun(lines, normalisedLines(piece), (lineIndex, length) => {
      if (length < LEAK_MIN_RUN) return;
      for (let index = lineIndex - length + 1; index <= lineIndex; index += 1) copied.add(index);
    });
  }
  return copied.size / lines.length;
};

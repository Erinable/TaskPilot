// Turns what a check step printed or wrote into results and diagnostics.
//
// Every parser yields the same two lists: `results` (tests, plus every
// error diagnostic as a failing entry, so baselines compare them alike) and
// `diagnostics` (file / line / severity / message, whatever the tool).
//
// SECURITY: the text is produced by code under review. It is only parsed,
// never executed, and every list is capped.
import path from 'node:path';

import { SEVERITIES } from '../../shared/check_steps.ts';
import type { CheckParser, Diagnostic, JsonDialect, Severity } from '../../shared/check_steps.ts';
import type { LooseJson } from '../infrastructure/loose_json.ts';

// One test result; `fullName` (suites joined) is the key baselines use.
export interface TestResult {
  name: string;
  fullName?: string;
  passed: boolean;
  skipped: boolean;
  todo: boolean;
}

export interface ParsedOutput {
  results: TestResult[];
  diagnostics: Diagnostic[];
}

export const MAX_DIAGNOSTICS = 2000;
const MAX_MESSAGE = 500;

// Parses TAP 13/14 result lines, which is what `node --test` emits.
// Subtests are indented; only top-level lines are collected so a suite does
// not double-count. Returns [] for output that isn't TAP.
export const parseTap = (output: string): TestResult[] => {
  const results: TestResult[] = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // subtest
    const match = /^(not ok|ok)\s+(\d+)\s*-?\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, verdict, , rest] = match;
    const name = rest.replace(/\s+#\s*(SKIP|TODO).*$/i, '').trim();
    const directive = /#\s*SKIP/i.test(rest) ? 'skip' : /#\s*TODO/i.test(rest) ? 'todo' : null;
    results.push({
      name,
      passed: verdict === 'ok',
      skipped: directive === 'skip',
      todo: directive === 'todo',
    });
  }
  return results;
};

// Node 22 switched `node --test` from TAP to its "spec" reporter, which marks
// results with ✔/✖ and indents nested tests. Many other runners (vitest, jest)
// print a similar shape, so this covers the common default case too.
const SPEC_LINE = /^(?<mark>[✔✖✗×])\s+(?<name>.+?)(?:\s+\((?<ms>[\d.]+)ms\))?\s*$/;

export const parseSpec = (output: string): TestResult[] => {
  const results: TestResult[] = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // nested test
    const match = SPEC_LINE.exec(line);
    if (!match) continue;
    // Both groups are mandatory in SPEC_LINE.
    const groups = match.groups as { mark: string; name: string };
    const name = groups.name.trim();
    // The spec reporter repeats failures in a trailing summary block; those
    // lines have no duration, so skip a name already recorded.
    if (results.some((r) => r.name === name)) continue;
    results.push({ name, passed: groups.mark === '✔', skipped: false, todo: false });
  }
  return results;
};

// libtest, the runner behind `cargo test`: each test binary prints
// `running N tests` and a `test <name> ... ok|FAILED|ignored` line per test
// on stdout, while Cargo names the binary on stderr (`Running <file>
// (target/.../deps/<binary>-<hash>)`, `Doc-tests <crate>`). The two streams
// arrive apart, but both list binaries in run order, so the k-th block
// belongs to the k-th binary, which scopes `fullName`: two crates can both
// have `tests::it_works`. Without a name for every block, names stay bare.
const LIBTEST_LINE = /^test (?<name>.+?) \.\.\. (?<verdict>ok|FAILED|ignored)(?:, .*)?$/;
const LIBTEST_BLOCK = /^running \d+ tests?$/;
const LIBTEST_BINARY = /^\s+Running .* \((?:.*[\\/])?(?<binary>[^\\/]+?)(?:-[0-9a-f]{16})?(?:\.exe)?\)$/;
const LIBTEST_DOCTESTS = /^\s+Doc-tests (?<crate>\S+)$/;

export const parseLibtest = (output: string): TestResult[] => {
  const binaries: string[] = [];
  const blocks: { name: string; verdict: string }[][] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const binary = LIBTEST_BINARY.exec(line)?.groups?.binary;
    const crate = LIBTEST_DOCTESTS.exec(line)?.groups?.crate;
    if (binary || crate) binaries.push(binary ?? `${crate} (doc)`);
    if (LIBTEST_BLOCK.test(line)) blocks.push([]);
    const match = LIBTEST_LINE.exec(line);
    // Both groups are mandatory in LIBTEST_LINE.
    if (match) (blocks.at(-1) ?? (blocks[0] = [])).push(match.groups as { name: string; verdict: string });
  }
  const scoped = binaries.length === blocks.length;
  return blocks.flatMap((tests, index) =>
    tests.map(({ name, verdict }) => ({
      name,
      fullName: scoped ? `${binaries[index]} › ${name}` : name,
      passed: verdict !== 'FAILED',
      skipped: verdict === 'ignored',
      todo: false,
    })),
  );
};

// libtest's JSON events, as `cargo nextest run --message-format libtest-json`
// prints them: one {"type":"test","event":"ok"|"failed"|"ignored","name"}
// per finished test. nextest names a test `<crate>::<binary>$<path>`; the
// binary scopes `fullName` the way parseLibtest() does.
const LIBTEST_EVENTS: Record<string, { passed: boolean; skipped: boolean }> = {
  ok: { passed: true, skipped: false },
  failed: { passed: false, skipped: false },
  timeout: { passed: false, skipped: false },
  ignored: { passed: true, skipped: true },
};

export const parseLibtestJson = (output: string): TestResult[] => {
  const results: TestResult[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('{"type":"test"')) continue;
    let event: LooseJson;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const verdict = LIBTEST_EVENTS[event?.event];
    if (!verdict || typeof event.name !== 'string' || !event.name) continue;
    const split = event.name.indexOf('$');
    const name = split < 0 ? event.name : event.name.slice(split + 1);
    const binary = split < 0 ? null : event.name.slice(0, split).split('::').pop();
    results.push({ name, fullName: binary ? `${binary} › ${name}` : name, ...verdict, todo: false });
  }
  return results;
};

// Picks the parser that matches the output: TAP first, then libtest's JSON
// (nextest also prints libtest text for failures, on stderr), libtest text,
// and spec lines last.
export const parseResults = (output: string): TestResult[] => {
  for (const parse of [parseTap, parseLibtestJson, parseLibtest]) {
    const results = parse(output);
    if (results.length > 0) return results;
  }
  return parseSpec(output);
};

const SEVERITY_WORDS: Record<string, Severity> = {
  error: 'error',
  err: 'error',
  fatal: 'error',
  e: 'error',
  warning: 'warning',
  warn: 'warning',
  w: 'warning',
};

// A tool's own severity word, or `fallback` when it has none.
export const toSeverity = (value: unknown, fallback: Severity): Severity => {
  if (typeof value !== 'string' || !value) return fallback;
  const word = value.toLowerCase();
  return SEVERITIES.includes(word as Severity) ? (word as Severity) : (SEVERITY_WORDS[word] ?? 'info');
};

const positive = (value: unknown): number | null => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
};

const text = (value: unknown, limit: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null);

// Paths relative to the repository root with forward slashes. Tools print
// paths relative to where they ran (`cwd`) or absolute; anything outside
// the root is kept as given, for display only.
export const relativeFile = (file: unknown, root: string, cwd: string): string | null => {
  const raw = text(file, 400);
  if (!raw) return null;
  const local = raw.startsWith('file://') ? decodeURIComponent(raw.slice('file://'.length)) : raw;
  const absolute = path.resolve(root, cwd, local);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : local;
};

const diagnostic = (fields: Partial<Record<keyof Diagnostic, unknown>>, fallback: Severity, root: string, cwd: string): Diagnostic | null => {
  const message = text(fields.message, MAX_MESSAGE);
  if (!message) return null;
  return {
    file: relativeFile(fields.file, root, cwd),
    line: positive(fields.line),
    column: positive(fields.column),
    severity: toSeverity(fields.severity, fallback),
    message,
    rule: text(fields.rule, 120),
  };
};

// Lines matching `pattern`, one diagnostic each. The pattern's named groups
// supply the fields; a line without a severity group gets `severity`.
export const parseRegex = (output: string, pattern: string, severity: Severity, root: string, cwd: string): Diagnostic[] => {
  const expression = new RegExp(pattern);
  const found: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = expression.exec(line.replace(/\r$/, ''));
    const item = match && diagnostic({ ...match.groups, message: match.groups?.message ?? match[0] }, severity, root, cwd);
    if (item) found.push(item);
    if (found.length >= MAX_DIAGNOSTICS) break;
  }
  return found;
};

// The JSON value in `output`, which may follow a banner line (npm prints
// one unless --silent). Null when there is none.
export const extractJson = (output: string): unknown => {
  const start = output.search(/^[[{]/m);
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
};

const ESLINT_SEVERITY: Record<number, Severity> = { 1: 'warning', 2: 'error' };

// ESLint's `-f json`: [{filePath, messages: [{line, column, severity, message, ruleId}]}].
const parseEslint = (value: unknown, root: string, cwd: string): Diagnostic[] | null => {
  if (!Array.isArray(value)) return null;
  const found: Diagnostic[] = [];
  for (const file of value as LooseJson[]) {
    for (const message of Array.isArray(file?.messages) ? (file.messages as LooseJson[]) : []) {
      const item = diagnostic(
        {
          file: file.filePath,
          line: message?.line,
          column: message?.column,
          severity: ESLINT_SEVERITY[message?.severity] ?? 'info',
          message: message?.message,
          rule: message?.ruleId,
        },
        'info',
        root,
        cwd,
      );
      if (item) found.push(item);
      if (found.length >= MAX_DIAGNOSTICS) return found;
    }
  }
  return found;
};

// TaskPilot's own dialect: {diagnostics: [{file, line, column, severity, message, rule}]}.
const parseOwn = (value: unknown, root: string, cwd: string): Diagnostic[] | null => {
  const list = (value as LooseJson | null)?.diagnostics;
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry: LooseJson) => diagnostic(entry ?? {}, 'error', root, cwd) ?? []).slice(0, MAX_DIAGNOSTICS);
};

// Cargo's `--message-format=json`: one JSON message per line. Compiler
// diagnostics are {"reason":"compiler-message","message":{level, message,
// code: {code}, spans: [{file_name, line_start, column_start, is_primary}]}};
// file names are relative to the workspace root. `--all-targets` reports a
// library's lints once per target, so repeats are dropped. Null when no
// line is a Cargo message.
export const parseCargo = (output: string, root: string, cwd: string): Diagnostic[] | null => {
  const found = new Map<string, Diagnostic>();
  let messages = 0;
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let value: LooseJson;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value?.reason !== 'string') continue;
    messages += 1;
    const message = value.reason === 'compiler-message' ? value.message : null;
    const spans: LooseJson[] = Array.isArray(message?.spans) ? message.spans : [];
    const span = spans.find((entry) => entry?.is_primary === true) ?? spans[0];
    const item =
      message &&
      diagnostic(
        {
          file: span?.file_name,
          line: span?.line_start,
          column: span?.column_start,
          severity: message.level,
          message: message.message,
          rule: message.code?.code,
        },
        'info',
        root,
        cwd,
      );
    if (item) found.set(JSON.stringify(item), item);
    if (found.size >= MAX_DIAGNOSTICS) break;
  }
  return messages ? [...found.values()] : null;
};

// Ruff's `check --output-format=json`: [{filename, location: {row, column},
// code, message, severity?}] with absolute file names. Older Ruff has no
// severity; every finding fails `ruff check`, so it is an error.
const parseRuff = (value: unknown, root: string, cwd: string): Diagnostic[] | null => {
  if (!Array.isArray(value)) return null;
  return (value as LooseJson[])
    .flatMap(
      (entry) =>
        diagnostic(
          {
            file: entry?.filename,
            line: entry?.location?.row,
            column: entry?.location?.column,
            severity: entry?.severity,
            message: entry?.message,
            rule: entry?.code ?? entry?.name,
          },
          'error',
          root,
          cwd,
        ) ?? [],
    )
    .slice(0, MAX_DIAGNOSTICS);
};

// Pyright's `--outputjson`: {generalDiagnostics: [{file, severity, message,
// range: {start: {line, character}}, rule}]}, positions counted from 0.
const parsePyright = (value: unknown, root: string, cwd: string): Diagnostic[] | null => {
  const list = (value as LooseJson | null)?.generalDiagnostics;
  if (!Array.isArray(list)) return null;
  return (list as LooseJson[])
    .flatMap((entry) => {
      const start = entry?.range?.start;
      return (
        diagnostic(
          {
            file: entry?.file,
            line: Number.isInteger(start?.line) ? start.line + 1 : null,
            column: Number.isInteger(start?.character) ? start.character + 1 : null,
            severity: entry?.severity,
            message: entry?.message,
            rule: entry?.rule,
          },
          'error',
          root,
          cwd,
        ) ?? []
      );
    })
    .slice(0, MAX_DIAGNOSTICS);
};

// mypy's `--output json`: one {file, line, column, message, code, severity}
// per line, files relative to where it ran, columns counted from 0. A clean
// run prints nothing; output with no mypy line at all is unparseable.
export const parseMypy = (output: string, root: string, cwd: string): Diagnostic[] | null => {
  const found: Diagnostic[] = [];
  let other = false;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let value: LooseJson | null;
    try {
      value = JSON.parse(line);
    } catch {
      value = null;
    }
    if (typeof value?.message !== 'string') {
      other = true;
      continue;
    }
    const item = diagnostic(
      {
        file: value.file,
        line: value.line,
        column: Number.isInteger(value.column) && value.column >= 0 ? value.column + 1 : null,
        severity: value.severity,
        message: value.message,
        rule: value.code,
      },
      'error',
      root,
      cwd,
    );
    if (item) found.push(item);
    if (found.length >= MAX_DIAGNOSTICS) break;
  }
  return found.length || !other ? found : null;
};

const JSON_PARSERS: Record<Exclude<JsonDialect, 'cargo' | 'mypy'>, (value: unknown, root: string, cwd: string) => Diagnostic[] | null> = {
  eslint: parseEslint,
  ruff: parseRuff,
  pyright: parsePyright,
  diagnostics: parseOwn,
};

export const parseJson = (output: string, dialect: JsonDialect, root: string, cwd: string): Diagnostic[] | null => {
  if (dialect === 'cargo') return parseCargo(output, root, cwd);
  if (dialect === 'mypy') return parseMypy(output, root, cwd);
  return JSON_PARSERS[dialect](extractJson(output), root, cwd);
};

const SARIF_LEVEL: Record<string, Severity> = { error: 'error', warning: 'warning', note: 'info', none: 'info' };

// One SARIF result with its first physical location.
const sarifResult = (result: LooseJson | null, root: string, cwd: string) => {
  const location = result?.locations?.[0]?.physicalLocation;
  const region = location?.region;
  return diagnostic(
    {
      file: location?.artifactLocation?.uri,
      line: region?.startLine,
      column: region?.startColumn,
      severity: SARIF_LEVEL[result?.level] ?? 'warning',
      message: result?.message?.text,
      rule: result?.ruleId,
    },
    'warning',
    root,
    cwd,
  );
};

// SARIF 2.1: runs[].results[] with a message and a physical location.
export const parseSarif = (output: string, root: string, cwd: string): Diagnostic[] | null => {
  const runs = (extractJson(output) as LooseJson | null)?.runs;
  if (!Array.isArray(runs)) return null;
  const results = (runs as LooseJson[]).flatMap((run) => (Array.isArray(run?.results) ? (run.results as LooseJson[]) : []));
  return results.flatMap((result) => sarifResult(result, root, cwd) ?? []).slice(0, MAX_DIAGNOSTICS);
};

// The key an error diagnostic is compared by against the baseline. The
// line is left out: unrelated edits above a problem move it.
export const diagnosticKey = (item: Diagnostic) => [item.file, item.rule, item.message].filter(Boolean).join(' › ');

// Failing tests as diagnostics, so every step shows the same list.
const testDiagnostics = (results: TestResult[]): Diagnostic[] =>
  results
    .filter((result) => !result.passed && !result.skipped && !result.todo)
    .slice(0, MAX_DIAGNOSTICS)
    .map((result) => ({ file: null, line: null, column: null, severity: 'error', message: result.fullName ?? result.name, rule: null }));

const fromDiagnostics = (diagnostics: Diagnostic[]): ParsedOutput => ({
  diagnostics,
  results: diagnostics
    .filter((item) => item.severity === 'error')
    .map((item) => ({ name: diagnosticKey(item), fullName: diagnosticKey(item), passed: false, skipped: false, todo: false })),
});

// `output` is stdout and stderr together; `content` is the report file or,
// for json/sarif without one, stdout alone. Null means the content could
// not be read in the configured format.
export const parseOutput = (
  parser: CheckParser,
  { output, content, root, cwd }: { output: string; content: string; root: string; cwd: string },
): ParsedOutput | null => {
  if (parser.format === 'tests' || parser.format === 'junit') {
    const results = parser.format === 'tests' ? parseResults(output).map((result) => ({ ...result, fullName: result.fullName ?? result.name })) : [];
    return { results, diagnostics: testDiagnostics(results) };
  }
  if (parser.format === 'exitcode') return { results: [], diagnostics: [] };
  if (parser.format === 'regex') return fromDiagnostics(parseRegex(output, parser.pattern, parser.severity, root, cwd));
  const diagnostics = parser.format === 'json' ? parseJson(content, parser.dialect, root, cwd) : parseSarif(content, root, cwd);
  return diagnostics && fromDiagnostics(diagnostics);
};

// JUnit results, read by ./test_report.ts, in the same shape.
export const fromTests = (results: TestResult[]): ParsedOutput => ({ results, diagnostics: testDiagnostics(results) });

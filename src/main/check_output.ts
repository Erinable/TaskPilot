// Turns what a check step printed or wrote into results and diagnostics.
//
// Every parser yields the same two lists: `results` (tests, plus every
// error diagnostic as a failing entry, so baselines compare them alike) and
// `diagnostics` (file / line / severity / message, whatever the tool).
//
// SECURITY: the text is produced by code under review. It is only parsed,
// never executed, and every list is capped.
import path from 'node:path';

import { SEVERITIES } from '../shared/check_steps.ts';
import type { CheckParser, Diagnostic, JsonDialect, Severity } from '../shared/check_steps.ts';
import type { LooseJson } from './loose_json.ts';

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

// Picks the parser that matches the output, preferring TAP when both appear.
export const parseResults = (output: string): TestResult[] => {
  const tap = parseTap(output);
  return tap.length > 0 ? tap : parseSpec(output);
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

export const parseJson = (output: string, dialect: JsonDialect, root: string, cwd: string): Diagnostic[] | null => {
  const value = extractJson(output);
  return dialect === 'eslint' ? parseEslint(value, root, cwd) : parseOwn(value, root, cwd);
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

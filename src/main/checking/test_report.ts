// Reads a report file a check step wrote into the workspace.
//
// SECURITY: the report is data produced by code under review. It is read
// only from the path the step is configured with, must be a regular file
// inside the workspace (no symlinks), is size-capped, and is parsed by a small
// tokenizer that understands just the JUnit elements below. Nothing in it is
// executed, and text from it reaches the model only as fenced data.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import type { TestResult } from './check_output.ts';

export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_CASES = 20000;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// Why a report was not trusted.
export type ReportProblem = 'missing' | 'stale' | 'not_a_file' | 'outside' | 'too_large' | 'invalid';

export interface ReportRead {
  trusted: boolean;
  problem: ReportProblem | null;
  results: TestResult[];
}

const decode = (text: string): string => {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
};

const attributes = (source: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decode(match[3] ?? match[4] ?? '');
  }
  return attrs;
};

// Parses JUnit XML into the same result shape as verification.parseTap():
// {name, fullName, passed, skipped, todo}. `fullName` joins the enclosing
// suites and the classname with " › " so baseline comparison has a stable key.
// Throws on input that has no <testsuite>/<testsuites> root.
const parseTestcase = (
  rest: string,
  suites: string[],
  current: TestResult | null,
  results: TestResult[],
  closing: string,
  selfClosing: string,
): TestResult | null => {
  if (closing) {
    if (current) results.push(current);
    return null;
  }
  if (current) results.push(current);
  const attrs = attributes(rest);
  const name = attrs.name ?? '';
  const scope = [...suites.filter(Boolean)];
  if (attrs.classname && scope[scope.length - 1] !== attrs.classname) scope.push(attrs.classname);
  const next = { name, fullName: [...scope, name].join(' › '), passed: true, skipped: false, todo: false };
  if (!selfClosing) return next;
  results.push(next);
  return null;
};

export const parseJunit = (xml: string): TestResult[] => {
  // Comments, CDATA and processing instructions carry no results; dropping
  // them keeps a "<testcase" inside a failure message from being tokenized.
  const text = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  if (!/<testsuites?[\s>/]/.test(text)) throw Object.assign(new Error('Not a JUnit report'), { code: 'invalid_report' });

  const results: TestResult[] = [];
  const suites: string[] = [];
  let current: TestResult | null = null;
  for (const match of text.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, rest, selfClosing] = match;
    if (tag === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attributes(rest).name ?? '');
    } else if (tag === 'testcase') {
      current = parseTestcase(rest, suites, current, results, closing, selfClosing);
      if (closing) continue;
    } else if (current && !closing && (tag === 'failure' || tag === 'error')) {
      current.passed = false;
    } else if (current && !closing && tag === 'skipped') {
      current.skipped = true;
    }
    if (results.length >= MAX_CASES) break;
  }
  if (current && results.length < MAX_CASES) results.push(current);
  return results;
};

// Stats a report path without following a symlink; null when absent.
export const statReport = async (root: string, relativePath: string): Promise<Stats | null> => {
  try {
    return await fs.lstat(path.join(root, relativePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
};

// Reads the report a run produced. `before` is statReport() taken before the
// run started: a report whose size and mtime did not change is stale, left
// from an earlier run, and is not trusted.
// problem is one of missing | stale | not_a_file | outside | too_large
export const readReportFile = async (
  root: string,
  relativePath: string,
  before: Stats | null,
): Promise<{ problem: ReportProblem } | { problem: null; content: string }> => {
  const after = await statReport(root, relativePath);
  if (!after) return { problem: 'missing' };
  if (!after.isFile() || after.isSymbolicLink()) return { problem: 'not_a_file' };
  if (after.size > MAX_REPORT_BYTES) return { problem: 'too_large' };
  if (before && before.mtimeMs === after.mtimeMs && before.size === after.size) return { problem: 'stale' };

  // A directory on the way could be a symlink pointing out of the workspace.
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(path.join(root, relativePath));
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { problem: 'outside' };
  return { problem: null, content: await fs.readFile(realFile, 'utf8') };
};

// A JUnit report; `invalid` when it is not one.
export const readReport = async (root: string, report: { path: string }, before: Stats | null): Promise<ReportRead> => {
  const read = await readReportFile(root, report.path, before);
  if (read.problem) return { trusted: false, problem: read.problem, results: [] };
  try {
    return { trusted: true, problem: null, results: parseJunit(read.content) };
  } catch {
    return { trusted: false, problem: 'invalid', results: [] };
  }
};

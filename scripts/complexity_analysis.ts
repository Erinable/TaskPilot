import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ESLint } from 'eslint';
import type { Rule } from 'eslint';

export type SourceEntry = { filePath: string; source: string };
export type ComplexityFinding = { filePath: string; functionId: string; line: number; column: number; complexity: number; limit: number };
export type ComplexityRegression = ComplexityFinding & { previous: number | null };

const execute = promisify(execFile);
const isSource = (filePath: string) => filePath.startsWith('src/') && /\.(ts|vue)$/.test(filePath) && !filePath.endsWith('.d.ts');
const git = async (cwd: string, argumentsList: string[]) =>
  (await execute('git', argumentsList, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })).stdout;

const functionIdentity = (node: Rule.Node, context: Rule.RuleContext, origin: string) => {
  const parts = [origin];
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) parts.push(node.id.name);
  let child: ReturnType<typeof context.sourceCode.getAncestors>[number] = node;
  for (const ancestor of context.sourceCode.getAncestors(node).reverse()) {
    if (ancestor.type === 'VariableDeclarator') parts.push(`variable:${context.sourceCode.getText(ancestor.id)}`);
    if (ancestor.type === 'ClassDeclaration' && ancestor.id) parts.push(`class:${ancestor.id.name}`);
    if (ancestor.type === 'Property' || ancestor.type === 'MethodDefinition' || ancestor.type === 'PropertyDefinition')
      parts.push(`property:${context.sourceCode.getText(ancestor.key)}`);
    if (ancestor.type === 'FunctionDeclaration' && ancestor.id) parts.push(`function:${ancestor.id.name}`);
    if (ancestor.type === 'CallExpression') {
      const index = ancestor.arguments.findIndex((argument) => argument === child);
      if (index >= 0) parts.push(`call:${context.sourceCode.getText(ancestor.callee)}:argument:${index}`);
    }
    child = ancestor;
  }
  return parts.reverse().join('/');
};

export const analyzeSources = async (entries: SourceEntry[], cwd: string): Promise<ComplexityFinding[]> => {
  const findings: ComplexityFinding[] = [];
  let functions: { functionId: string; start: number; end: number }[] = [];
  let identities = new Map<string, number>();
  const identityRule: Rule.RuleModule = {
    meta: { schema: [] },
    create: (context) => ({
      onCodePathStart: (codePath, node) => {
        if (codePath.origin === 'program') return;
        if (!node.range) throw new Error('ESLint did not provide a code path range');
        const identity = functionIdentity(node, context, codePath.origin);
        const occurrence = (identities.get(identity) ?? 0) + 1;
        identities.set(identity, occurrence);
        const parent = node.parent;
        const container = parent && (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') ? parent : node;
        if (!container.range) throw new Error('ESLint did not provide a function container range');
        functions.push({ functionId: `${identity}#${occurrence}`, start: container.range[0], end: node.range[1] });
      },
    }),
  };
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: fileURLToPath(new URL('../eslint.config.ts', import.meta.url)),
    allowInlineConfig: false,
    overrideConfig: [{ plugins: { 'complexity-report': { rules: { identities: identityRule } } }, rules: { 'complexity-report/identities': 'warn' } }],
  });
  for (const entry of entries) {
    functions = [];
    identities = new Map();
    const [result] = await eslint.lintText(entry.source, { filePath: path.resolve(cwd, entry.filePath) });
    for (const message of result.messages) {
      if (message.fatal) throw new Error(`${entry.filePath}:${message.line}: ${message.message}`);
      if (message.ruleId !== 'complexity') continue;
      const values = /has a complexity of (\d+)\. Maximum allowed is (\d+)\./.exec(message.message);
      if (!values) throw new Error(`Unrecognized ESLint complexity diagnostic: ${message.message}`);
      const lines = entry.source.split('\n');
      const offset = lines.slice(0, message.line - 1).reduce((length, line) => length + line.length + 1, 0) + message.column - 1;
      const matched = functions
        .filter((candidate) => candidate.start <= offset && candidate.end > offset)
        .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
      if (!matched) throw new Error(`Cannot identify complex function at ${entry.filePath}:${message.line}`);
      findings.push({
        filePath: entry.filePath,
        functionId: matched.functionId,
        line: message.line,
        column: message.column,
        complexity: Number(values[1]),
        limit: Number(values[2]),
      });
    }
  }
  return findings.sort((left, right) => right.complexity - left.complexity || left.filePath.localeCompare(right.filePath) || left.line - right.line);
};

export const findRegressions = (current: ComplexityFinding[], baseline: ComplexityFinding[]): ComplexityRegression[] => {
  const previous = new Map(baseline.map((finding) => [JSON.stringify([finding.filePath, finding.functionId]), finding.complexity]));
  return current.flatMap((finding) => {
    const before = previous.get(JSON.stringify([finding.filePath, finding.functionId]));
    return finding.complexity > (before ?? finding.limit) ? [{ ...finding, previous: before ?? null }] : [];
  });
};

export const readCurrentSources = async (cwd: string): Promise<SourceEntry[]> => {
  const names = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src']);
  const sources: SourceEntry[] = [];
  for (const filePath of new Set(names.split('\0').filter(isSource))) {
    try {
      sources.push({ filePath, source: await fs.readFile(path.join(cwd, filePath), 'utf8') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return sources;
};

export const readBaselineSources = async (cwd: string, base: string, current: ComplexityFinding[]): Promise<{ revision: string; sources: SourceEntry[] }> => {
  const revision = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
  const paths = new Set((await git(cwd, ['ls-tree', '-r', '--name-only', '-z', revision, '--', 'src'])).split('\0').filter(isSource));
  const changes = (await git(cwd, ['diff', '--name-status', '-z', '--find-renames', revision, '--', 'src'])).split('\0');
  const renames = new Map<string, string>();
  for (let index = 0; index < changes.length && changes[index];) {
    const status = changes[index++];
    const original = changes[index++];
    if (status.startsWith('R') || status.startsWith('C')) renames.set(changes[index++], original);
  }
  const sources: SourceEntry[] = [];
  for (const filePath of new Set(current.map((finding) => finding.filePath))) {
    const original = renames.get(filePath) ?? filePath;
    if (paths.has(original)) sources.push({ filePath, source: await git(cwd, ['show', `${revision}:${original}`]) });
  }
  return { revision, sources };
};

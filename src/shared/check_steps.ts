// The fixed check steps every project maps its tools onto, and the one shape
// every step's output is turned into. Reviews, the coding loop and grading
// only know these steps, never a tool.

export const STEP_KINDS = ['setup', 'build', 'format', 'lint', 'typecheck', 'test', 'coverage'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

// A fixed step, or a project's own step as `custom:<name>`.
export type StepId = StepKind | `custom:${string}`;

export const CUSTOM_PREFIX = 'custom:';
export const CUSTOM_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// How a step's output is read.
//   tests     TAP, spec or libtest lines on stdout (node --test, vitest,
//             cargo test, nextest's libtest-json)
//   junit     a JUnit XML report file
//   json      stdout or a report file in a named JSON dialect
//   sarif     SARIF 2.1 on stdout or in a report file
//   regex     one diagnostic per matching output line
//   exitcode  nothing but the exit code
export const PARSER_FORMATS = ['tests', 'junit', 'json', 'sarif', 'regex', 'exitcode'] as const;

export type ParserFormat = (typeof PARSER_FORMATS)[number];

// JSON dialects: ESLint's `-f json`, Cargo's `--message-format=json` (one
// JSON message per line, as cargo build / check / clippy print), or
// TaskPilot's own {diagnostics: [{file, line, column, severity, message, rule}]}.
export const JSON_DIALECTS = ['eslint', 'cargo', 'diagnostics'] as const;

export type JsonDialect = (typeof JSON_DIALECTS)[number];

// A step's parser. `path` is a report file relative to the step's working
// directory; without one, json and sarif read stdout. A regex may name the
// groups file, line, column, severity, message and rule; without a message
// group the matched text is the message.
export type CheckParser =
  | { format: 'tests' }
  | { format: 'junit'; path: string }
  | { format: 'json'; dialect: JsonDialect; path: string | null }
  | { format: 'sarif'; path: string | null }
  | { format: 'regex'; pattern: string; severity: Severity }
  | { format: 'exitcode' };

export const SEVERITIES = ['error', 'warning', 'info'] as const;

export type Severity = (typeof SEVERITIES)[number];

// One finding, whatever tool produced it. `file` is relative to the
// repository root; a failing test has no file.
export type Diagnostic = { file: string | null; line: number | null; column: number | null; severity: Severity; message: string; rule: string | null };

// Where an effective step comes from: this machine's settings, the
// repository's taskpilot.toml, or the preset that file names.
export type StepSource = 'local' | 'project' | 'preset';

export const isStepKind = (value: unknown): value is StepKind => STEP_KINDS.includes(value as StepKind);

export const isCustomStepId = (value: unknown): value is `custom:${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOM_PREFIX) && CUSTOM_NAME.test(value.slice(CUSTOM_PREFIX.length));

export const isStepId = (value: unknown): value is StepId => isStepKind(value) || isCustomStepId(value);

// Fixed steps in their fixed order, then custom steps by name.
export const orderSteps = (ids: Iterable<string>): StepId[] => {
  const set = new Set(ids);
  return [...STEP_KINDS.filter((kind) => set.has(kind)), ...[...set].filter(isCustomStepId).sort()];
};

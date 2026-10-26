// Commands as TaskPilot stores and runs them: an executable plus an argument
// array, never a shell string. Settings type a command line; this tokenizer
// turns it into {command, args} without expanding or executing anything.

export type WorkspaceErrorCode =
  | 'invalid_report'
  | 'invalid_check'
  | 'invalid_command'
  | 'unterminated_quote'
  | 'shell_syntax'
  | 'invalid_json'
  | 'invalid_step'
  | 'invalid_project'
  | 'invalid_course';

// An executable plus its argument array; never a shell string.
export interface CommandEntry {
  command: string;
  args: string[];
}

// Unquoted tokens a user might type expecting shell behaviour. They would
// reach the program as literal arguments and fail confusingly, so they are
// rejected with a pointer to package.json scripts instead.
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<', '2>', '2>&1', '&>']);

export class WorkspaceError extends Error {
  code: WorkspaceErrorCode;
  field?: string;

  // `field` names the settings input at fault ('root' or a command kind).
  constructor(message: string, code: WorkspaceErrorCode, field?: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    if (field) this.field = field;
  }
}

// A command is stored as {command, args} — an executable plus an argument
// array, never a shell string. This keeps execution off the shell so nothing
// in the configured values can be interpreted as an operator.
export const normalizeCommand = (value: unknown, kind: string): CommandEntry | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError(`${kind} command must be an object`, 'invalid_command', kind);
  }
  const { command, args = [] } = value as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !command.trim()) {
    throw new WorkspaceError(`${kind} command is missing an executable`, 'invalid_command', kind);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new WorkspaceError(`${kind} command args must be strings`, 'invalid_command', kind);
  }
  return { command: command.trim(), args: [...args] };
};

// Splits a command line typed in settings into {command, args}.
//
// This is a tokenizer, not a shell: quotes group words and backslashes escape,
// but nothing is expanded, substituted, or executed. Returns null for a blank
// line, which means "not configured".
type CommandToken = { value: string; quoted: boolean };

const commandFromTokens = (tokens: CommandToken[], kind: string): CommandEntry | null => {
  if (tokens.length === 0) return null;
  const operator = tokens.find((token) => !token.quoted && SHELL_OPERATORS.has(token.value));
  if (operator) throw new WorkspaceError(`${kind} command uses shell syntax "${operator.value}"`, 'shell_syntax', kind);
  const [command, ...args] = tokens.map((token) => token.value);
  return normalizeCommand({ command, args }, kind);
};

export const parseCommandLine = (text: unknown, kind: string): CommandEntry | null => {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') {
    throw new WorkspaceError(`${kind} command must be text`, 'invalid_command', kind);
  }

  const tokens: CommandToken[] = [];
  let value = '';
  let inToken = false;
  let quoted = false; // any part of the current token was quoted or escaped
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) value += text[++i];
      else value += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      quoted = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      value += text[++i];
      inToken = true;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push({ value, quoted });
      value = '';
      inToken = false;
      quoted = false;
    } else {
      value += ch;
      inToken = true;
    }
  }

  if (quote) {
    throw new WorkspaceError(`${kind} command has an unterminated ${quote} quote`, 'unterminated_quote', kind);
  }
  if (inToken) tokens.push({ value, quoted });
  return commandFromTokens(tokens, kind);
};

// Inverse of parseCommandLine(), quoting only where needed.
export const formatCommandLine = (entry: CommandEntry | null | undefined): string => {
  if (!entry) return '';
  return [entry.command, ...entry.args]
    .map((token) => (token === '' || /[\s'"\\]/.test(token) || SHELL_OPERATORS.has(token) ? `'${token.replace(/'/g, "'\\''")}'` : token))
    .join(' ');
};

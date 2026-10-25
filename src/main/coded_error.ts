// Errors carrying the machine-readable code (and form field) IPC failures
// send. Domain services throw them; the IPC layer turns them into results.

// An Error carrying the machine-readable fields IPC failures send.
export type CodedError = Error & { code?: unknown; field?: unknown };

export const codedError = (message: string, code: string, field?: string): CodedError => {
  const error: CodedError = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
};

export const failWith: (message: string, code: string, field?: string) => never = (message, code, field) => {
  throw codedError(message, code, field);
};

// Caught errors are Errors; the stores record their code and message.
export const asAgentError = (error: unknown) => error as { code?: string; message: string };

export const errorCode = (error: unknown): string | undefined => {
  const code = (error as CodedError).code;
  return typeof code === 'string' ? code : undefined;
};

export const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw codedError(`${name} must be a non-empty string`, 'invalid_argument');
  return value;
};

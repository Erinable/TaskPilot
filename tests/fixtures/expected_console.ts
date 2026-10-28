// console.error / console.warn and the main-process logger's warn / error
// during a test are failures unless the test said it expects them.
// tests/setup/console_guard.ts records every call and fails the test in
// afterEach; output before any test (a module that warns on import) fails the
// first test of the file.
import { format } from 'node:util';

export type ConsoleLevel = 'error' | 'warn';
type Expectation = { level: ConsoleLevel; match: RegExp; calls: unknown[][] };

let expectations: Expectation[] = [];
let unexpected: { level: ConsoleLevel; text: string }[] = [];

const textOf = (values: unknown[]) => values.map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : format(value))).join(' ');

// Quiets this test's calls at `level` whose text matches, and returns them.
export const expectConsole = (level: ConsoleLevel, match: RegExp) => {
  const expectation: Expectation = { level, match, calls: [] };
  expectations.push(expectation);
  return expectation.calls;
};

// False when the call was unexpected, so the guard still prints it.
export const recordConsole = (level: ConsoleLevel, values: unknown[]) => {
  const text = textOf(values);
  const expectation = expectations.find((entry) => entry.level === level && entry.match.test(text));
  if (expectation) {
    expectation.calls.push(values);
    return true;
  }
  unexpected.push({ level, text });
  return false;
};

export const takeUnexpected = () => {
  const found = unexpected;
  unexpected = [];
  expectations = [];
  return found;
};

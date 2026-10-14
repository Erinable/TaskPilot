import { test } from 'vitest';
import assert from 'node:assert/strict';

import { CODING_SETUP_TEXT, codingSetupIssue } from '../../src/shared/coding_setup.ts';

test('codingSetupIssue() names each real failure the probe reports', () => {
  // The messages sudo and the wrapper print, as seen on macOS.
  const cases: [string | null, string][] = [
    ['sudo: unknown user taskpilot-coder\nsudo: error initializing audit plugin sudoers_audit', 'user_missing'],
    ['sudo: /usr/local/libexec/taskpilot-coding-wrapper: command not found', 'wrapper_missing'],
    ['sudo: a password is required', 'sudo_denied'],
    ["taskpilot coding wrapper: claude CLI unavailable; install it in the dedicated user's ~/.local/bin after normal sign-in", 'cli_missing'],
    ['taskpilot coding wrapper: pi CLI version probe failed', 'cli_broken'],
    ['Unsupported coding CLI configuration', 'unsupported_config'],
    ['Coding runtime probe timed out', 'timeout'],
    ['something new', 'unknown'],
    [null, 'unknown'],
  ];
  for (const [reason, issue] of cases) assert.equal(codingSetupIssue(reason), issue, String(reason));
});

test('setup problems point at the setup script; CLI and config problems do not', () => {
  assert.deepEqual(
    Object.entries(CODING_SETUP_TEXT)
      .filter(([, text]) => text.runSetup)
      .map(([issue]) => issue),
    ['user_missing', 'wrapper_missing', 'sudo_denied', 'unknown'],
  );
  for (const text of Object.values(CODING_SETUP_TEXT)) assert.doesNotMatch(text.title + text.body, /sudo:|audit plugin/);
});

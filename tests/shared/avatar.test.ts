import { expect, test } from 'vitest';

import { initialsOf } from '../../src/shared/avatar.ts';

test.each([
  ['', ''],
  ['   ', ''],
  [null, ''],
  [undefined, ''],
  ['---', ''],
  ['...', ''],
  ['___', ''],
  [' ._- ', ''],
  ['ada', 'A'],
  ['Ada Lovelace', 'AL'],
  ['ada byron lovelace', 'AL'],
  ['han.guoliang', 'HG'],
  ['韩国梁', '韩'],
  ['한글', '한'],
  ['かな', 'か'],
  ['カナ', 'カ'],
  ['😀 smile', '😀S'],
])('initialsOf(%j) returns %j', (name, expected) => {
  expect(initialsOf(name)).toBe(expected);
});

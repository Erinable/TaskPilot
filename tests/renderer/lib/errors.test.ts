import { test } from 'vitest';
import assert from 'node:assert/strict';

import { describeError, describeErrorInfo, ERROR_HINTS } from '../../../src/renderer/src/lib/errors.ts';

test('storage recovery errors keep the original file and recovery instructions on the startup splash and in views', () => {
  const message = '应用数据文件已损坏，原文件保持不变：/Users/example/TaskPilot/preferences.json。请从有效备份恢复后重试。';
  const error = Object.assign(new Error(message), { code: 'storage_corrupt' });
  assert.equal(describeError(error), message);
  assert.equal(describeErrorInfo({ code: 'storage_corrupt', message }), message);
  assert.equal(describeErrorInfo({ code: 'storage_corrupt' }), ERROR_HINTS.storage_corrupt);
});

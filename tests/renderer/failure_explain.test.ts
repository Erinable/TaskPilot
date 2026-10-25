import { test } from 'vitest';
import assert from 'node:assert/strict';

import { explainFailure } from '../../src/renderer/src/lib/failure_explain.ts';
import type { FailureInput } from '../../src/renderer/src/lib/failure_explain.ts';

const run = (overrides: Partial<FailureInput> = {}): FailureInput => ({ kind: 'test', exitCode: 1, timedOut: false, output: '', failed: 0, ...overrides });

test('a passing run needs no explanation', () => {
  assert.equal(explainFailure(run({ exitCode: 0 })), null);
});

test('each common failure gets its own plain reading', () => {
  const titles = [
    explainFailure(run({ timedOut: true, failed: 3 })),
    explainFailure(run({ exitCode: 127, output: 'sh: vitest: command not found' })),
    explainFailure(run({ output: "Error: Cannot find module './auth/login'\nRequire stack:" })),
    explainFailure(run({ kind: 'build', output: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable\nsrc/b.ts(1,1): error TS2304: x" })),
    explainFailure(run({ output: 'SyntaxError: Unexpected token }' })),
    explainFailure(run({ failed: 2, output: 'not ok 1 - login\nnot ok 2 - lock' })),
    explainFailure(run({ output: 'something broke' })),
    explainFailure(run({ kind: 'lint', output: '3:1 error no-unused-vars' })),
    explainFailure(run({ kind: 'build', output: 'vite: error during build' })),
    explainFailure(run({ kind: 'custom:smoke', output: 'EADDRINUSE' })),
  ].map((explanation) => explanation?.title);
  assert.deepEqual(titles, [
    '命令运行太久，被停掉了',
    '找不到要运行的命令',
    '有一个模块找不到',
    '类型检查没通过（2 处）',
    '代码有语法错误',
    '2 个测试没通过',
    '测试命令失败了，但没有测试报告失败',
    '代码风格检查发现了问题',
    '项目没能构建成功',
    '冒烟测试失败：程序没能正常启动或响应',
  ]);
});

test('a missing module is named, as inline code', () => {
  const detail = explainFailure(run({ output: "Cannot find module 'zod'" }))?.detail ?? '';
  assert.ok(detail.startsWith('缺的是 `zod`。'), detail);
  assert.ok(explainFailure(run({ output: "ModuleNotFoundError: No module named 'requests'" }))?.detail.startsWith('缺的是 `requests`。'));
});

test('a run of an unknown kind (older stored data) falls back to the exit code', () => {
  assert.deepEqual(explainFailure(run({ kind: 'deploy' as never, exitCode: 2 })), { title: '命令以退出码 2 结束', detail: '看下面输出里的第一条报错。' });
});

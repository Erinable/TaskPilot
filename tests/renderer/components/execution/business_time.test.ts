// @vitest-environment happy-dom
// The execution page's timestamps (the coding transcript, deviations, the
// plan revision and the review) read in the business time zone, not the
// system's: 17:00 UTC is 01:00 the next day in Shanghai.
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

import { mountView } from '../../mount_view.ts';
import CodingTranscript from '../../../../src/renderer/src/components/execution/CodingTranscript.vue';
import DeviationPanel from '../../../../src/renderer/src/components/execution/DeviationPanel.vue';
import ReviewResult from '../../../../src/renderer/src/components/execution/ReviewResult.vue';
import type { ReviewOutcome } from '../../../../src/renderer/src/components/execution/ReviewResult.vue';
import { installFakeApi } from '../../ipc_fakes.ts';
import { taskView } from '../../execution_fakes.ts';

const AT = '2026-09-30T17:05:09Z';

beforeEach(() => {
  setActivePinia(createPinia());
  installFakeApi();
});

const mountWith = (component: Parameters<typeof h>[0], props: Record<string, unknown>) => mountView(defineComponent({ render: () => h(component, props) }));

test('the coding transcript times each event in the business time zone', async () => {
  const item = { id: 'c', kind: 'command' as const, status: 'done' as const, command: 'npm test', exitCode: 0, output: '', outputTruncated: false };
  const wrapper = await mountWith(CodingTranscript, { events: [{ sequence: 1, at: AT, type: 'tool', text: 'npm test', item }] });
  expect(wrapper.get('.t-commands time').text()).toBe('01:05:09');
});

test('deviations and the plan revision are dated in the business time zone', async () => {
  const task = taskView({
    deviations: [{ note: '缺少文件', stepIndex: null, filePath: null, reportedAt: AT, resolution: null }],
    revision: { version: 2, reason: '', changes: [], revisedAt: AT },
  });
  const wrapper = await mountWith(DeviationPanel, { task });
  expect(wrapper.get('.deviation-revision-title').text()).toContain('第 2 版计划，2026-10-01 01:05:09 由 Architect 修订');
  expect(wrapper.get('.deviation-item small').text()).toContain('2026-10-01 01:05:09');
});

test('a finished review shows when it finished in the business time zone', async () => {
  const review: ReviewOutcome = {
    status: 'passed',
    error: null,
    startedAt: AT,
    finishedAt: AT,
    reasons: [],
    attention: [],
    checks: [],
    verification: null,
    acceptance: [],
    report: null,
    diff: { files: [], skipped: [], outOfScope: [] },
    costUsd: 0,
  };
  const wrapper = await mountWith(ReviewResult, { task: taskView(), review });
  expect(wrapper.text()).toContain('2026-10-01 01:05:09');
});

test('the coding transcript opens a failed command with its output, and keeps passing ones folded', async () => {
  const done = {
    id: 'a',
    kind: 'command' as const,
    status: 'done' as const,
    command: "/bin/zsh -lc 'ls'",
    exitCode: 0,
    output: 'App.tsx',
    outputTruncated: false,
  };
  const failed = {
    id: 'b',
    kind: 'command' as const,
    status: 'failed' as const,
    command: "/bin/zsh -lc 'npm test'",
    exitCode: 127,
    output: 'jest: command not found',
    outputTruncated: false,
  };
  const wrapper = await mountWith(CodingTranscript, {
    events: [
      { sequence: 1, at: AT, type: 'text', text: '先看看 `package.json`。' },
      { sequence: 2, at: AT, type: 'tool', text: 'ls', item: done },
      { sequence: 3, at: AT, type: 'tool', text: 'npm test', item: failed },
    ],
  });
  expect(wrapper.get('.t-message code').text()).toBe('package.json');
  expect(wrapper.get('.t-commands summary').text()).toContain('运行了 2 条命令，1 条失败');
  const rows = wrapper.findAll('.t-command');
  expect(rows.map((row) => row.get('.t-cmd').text())).toEqual(['ls', 'npm test']);
  expect(rows[0].get('details').attributes('open')).toBeUndefined();
  expect(rows[1].get('details').attributes('open')).toBeDefined();
  expect(rows[1].get('.t-badge').text()).toBe('退出码 127');
  expect(rows[1].get('.t-output').text()).toContain('jest: command not found');
});

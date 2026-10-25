// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import CodingPanel from '../../../src/renderer/src/components/execution/CodingPanel.vue';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { codingRun, installApi, taskView } from '../execution_fakes.ts';
import type * as codingTypes from '../../../src/shared/coding_types.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

let api: ReturnType<typeof installApi>;
const offline = (reason: string): codingTypes.CodingRuntimeStatus => ({
  backend: 'claude',
  protocol: 'claude-jsonl',
  boundary: 'separate-user',
  setupScript: 'scripts/setup-coding-agent-user.sh',
  available: false,
  version: null,
  reason,
  config: { user: 'taskpilot-coder', cli: 'claude', model: '', thinking: 'default', timeoutMinutes: 30 },
});

beforeEach(() => {
  setActivePinia(createPinia());
  const current = { task: taskView() };
  api = installApi(current);
  useExecutionStore().current = current.task;
});

const render = async () => {
  const wrapper = mount(CodingPanel, { props: { task: useExecutionStore().current as packageTypes.TaskView } });
  await flushPromises();
  return wrapper;
};

test('a missing coding user is explained in plain words, with the two setup commands', async () => {
  api.coding.status.mockResolvedValue({ ok: true, data: offline('sudo: unknown user taskpilot-coder\nsudo: error initializing audit plugin sudoers_audit') });
  const wrapper = await render();
  const box = wrapper.find('.coding-offline');
  expect(box.find('strong').text()).toBe('还没有设置编码专用账号');
  expect(box.findAll('.coding-command').map((node) => node.text())).toEqual([
    'scripts/setup-coding-agent-user.sh',
    'scripts/setup-coding-agent-user.sh --apply',
  ]);
  // The raw sudo text is kept, folded away rather than leading.
  expect(box.find('p').text()).not.toContain('sudo:');
  expect(box.find('.coding-raw pre').text()).toContain('unknown user taskpilot-coder');

  api.coding.status.mockClear();
  await box.find('.coding-setup-actions button').trigger('click');
  expect(api.coding.status).toHaveBeenCalled();
});

test('a missing CLI does not send the user back to the setup script', async () => {
  api.coding.status.mockResolvedValue({
    ok: true,
    data: offline("taskpilot coding wrapper: claude CLI unavailable; install it in the dedicated user's ~/.local/bin after normal sign-in"),
  });
  const wrapper = await render();
  expect(wrapper.find('.coding-offline strong').text()).toBe('编码专用账号里还没装所选的 CLI');
  expect(wrapper.find('.coding-command').exists()).toBe(false);
});

test('a failed round explains itself in plain words and folds the raw message', async () => {
  const run = codingRun({ status: 'failed', error: { code: 'coding_exit_failed', message: 'codex exited with code 1: not logged in' } });
  useExecutionStore().current = { ...useExecutionStore().current!, codingRun: run };
  api.coding.get.mockResolvedValue({ ok: true, data: useExecutionStore().current } as never);
  const wrapper = await render();
  const error = wrapper.get('.coding-error');
  expect(error.find('span').text()).toContain('中途出错退出');
  expect(error.text()).not.toContain('coding_exit_failed');
  expect(error.find('.coding-raw pre').text()).toContain('not logged in');
  // Runtime details are folded; elapsed time and cost lead.
  expect(wrapper.find('.coding-summary').text()).toContain('费用');
  expect(wrapper.find('.coding-summary details summary').text()).toBe('运行详情');
});

test('the instruction starts prefilled, so starting needs no typing', async () => {
  const wrapper = await render();
  expect((wrapper.get('#codingInstruction').element as HTMLTextAreaElement).value).toContain('执行指令');
  expect(wrapper.get('.coding-actions .primary-button').attributes('disabled')).toBeUndefined();
});

test('the patch review shows a coloured diff per file', async () => {
  const run = codingRun();
  useExecutionStore().current = { ...useExecutionStore().current!, codingRun: run };
  api.coding.get.mockResolvedValue({ ok: true, data: useExecutionStore().current } as never);
  api.coding.patch.mockResolvedValue({
    ok: true,
    data: {
      digest: 'digest',
      files: [{ path: 'src/a.ts', added: 1, removed: 1, binary: false, highRisk: false }],
      blocked: [],
      patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    },
  } as never);
  const wrapper = await render();
  expect(wrapper.findAll('.coding-files .diff-line.add').map((line) => line.text())).toEqual(['+new']);
  expect(wrapper.findAll('.coding-files .diff-line.del').map((line) => line.text())).toEqual(['-old']);
});

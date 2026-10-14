// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import CodingPanel from '../../../src/renderer/src/components/execution/CodingPanel.vue';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { installApi, taskView } from '../execution_fakes.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

let api: ReturnType<typeof installApi>;
const offline = (reason: string): ipc.CodingRuntimeStatus => ({
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
  const wrapper = mount(CodingPanel, { props: { task: useExecutionStore().current as ipc.TaskView } });
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

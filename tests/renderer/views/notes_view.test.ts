// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import NotesView from '../../../src/renderer/src/views/NotesView.vue';
import { useNotesStore } from '../../../src/renderer/src/stores/notes.ts';
import { useRepositoriesStore } from '../../../src/renderer/src/stores/repositories.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  openDialogs: { value: 0 },
}));

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const NOTE: ipc.Note = {
  id: 'n1',
  title: '用例要有断言',
  body: '<b>没有 expect</b>',
  category: 'writing',
  tags: ['测试'],
  source: { repositoryId: 'r1', repositoryName: 'app', packageId: 'p1', packageTitle: '登录', file: 'src/a.ts', line: 4 },
  createdAt: '',
  updatedAt: '',
};

let api: { notes: Record<string, ReturnType<typeof vi.fn>>; workspace: { openFile: ReturnType<typeof vi.fn> } };

const mountView = async (notes: ipc.Note[]) => {
  api.notes.list.mockImplementation(() => ok(notes));
  const pinia = createPinia();
  setActivePinia(pinia);
  useRepositoriesStore().currentId = 'r1';
  const wrapper = mount(NotesView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  document.body.replaceChildren();
  api = {
    notes: {
      list: vi.fn(() => ok([])),
      create: vi.fn((input: ipc.NoteInput) => ok({ ...input, id: 'new', createdAt: '', updatedAt: '' })),
      update: vi.fn((id: string, input: ipc.NoteInput) => ok({ ...NOTE, ...input, id })),
      remove: vi.fn(() => ok(true)),
    },
    workspace: { openFile: vi.fn(() => ok('vscode')) },
  };
  Object.defineProperty(window, 'taskpilot', { value: api, configurable: true, writable: true });
});

describe('NotesView', () => {
  test('with no notes it says how to get one', async () => {
    const wrapper = await mountView([]);
    expect(wrapper.get('[data-notes-empty]').text()).toContain('存为笔记');
  });

  test('shows a note as text with its source, which opens the file in its own repository', async () => {
    const wrapper = await mountView([NOTE]);
    const card = wrapper.get('[data-note="n1"]');
    expect(card.find('b').exists()).toBe(false);
    expect(card.text()).toContain('<b>没有 expect</b>');
    expect(card.text()).toContain('写法');
    await card.get('.note-source').trigger('click');
    expect(api.workspace.openFile).toHaveBeenCalledWith('src/a.ts', 4);
  });

  test('writing a note by hand saves it with no source', async () => {
    const wrapper = await mountView([]);
    await wrapper.get('[data-action="new-note"]').trigger('click');
    await wrapper.get('#noteTitle').setValue('命名写全');
    await wrapper.get('form[data-note-editor]').trigger('submit');
    await flushPromises();
    expect(api.notes.create).toHaveBeenCalledWith({ title: '命名写全', body: '', category: null, tags: [], source: null });
    expect(wrapper.find('[data-note-editor]').exists()).toBe(false);
    expect(wrapper.get('[data-note="new"]').text()).toContain('命名写全');
  });

  test('deleting asks first', async () => {
    const wrapper = await mountView([NOTE]);
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await wrapper.get('[data-action="delete-note"]').trigger('click');
    await flushPromises();
    expect(api.notes.remove).not.toHaveBeenCalled();
    await wrapper.get('[data-action="delete-note"]').trigger('click');
    await flushPromises();
    expect(api.notes.remove).toHaveBeenCalledWith('n1');
    expect(useNotesStore().notes).toEqual([]);
  });
});

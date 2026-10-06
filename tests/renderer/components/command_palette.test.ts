// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import CommandPalette from '../../../src/renderer/src/components/CommandPalette.vue';
import { usePaletteStore } from '../../../src/renderer/src/stores/palette.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useSettingsStore } from '../../../src/renderer/src/stores/settings.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { openDialogs } from '../../../src/renderer/src/lib/feedback.ts';
import { taskView } from '../execution_fakes.ts';
import { installApi, requirement } from '../requirements_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

const payload = '<img src=x onerror="window.hacked=1">';

describe('CommandPalette', () => {
  let pinia: ReturnType<typeof createPinia>;
  let wrapper: ReturnType<typeof mount> | null = null;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    openDialogs.value = 0;
    const list = [requirement({ id: 'r1', title: '邮箱登录', status: 'answering' }), requirement({ id: 'r2', title: payload, status: 'reviewing' })];
    installApi({ list });
    useRequirementsStore().items = list;
    useTasksStore().tasks = [
      taskView({ id: 't1', title: '登录接口', status: 'pending' }),
      taskView({ id: 't2', title: payload, status: 'in_progress', module: 'web' }),
    ];
    trigger = document.createElement('button');
    document.body.appendChild(trigger);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.replaceChildren();
  });

  const render = async () => {
    wrapper = mount(CommandPalette, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    trigger.focus();
    usePaletteStore().openPalette();
    await flushPromises();
    return document.querySelector<HTMLInputElement>('.palette-input')!;
  };

  const type = async (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
  };

  const key = async (target: EventTarget, name: string, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
    await flushPromises();
  };

  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const selected = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');

  test('renders an accessible dialog with grouped defaults', async () => {
    const input = await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(input.getAttribute('role')).toBe('combobox');
    expect([...document.querySelectorAll('.palette-group-label')].map((node) => node.textContent)).toEqual(['工作包', '需求']);
    expect(options().map((node) => node.dataset.key)).toEqual(['task:t1', 'task:t2', 'requirement:r1', 'requirement:r2']);
    expect(input.getAttribute('aria-activedescendant')).toBe(selected()?.id);
    expect(openDialogs.value).toBe(1);
  });

  test('user text with markup renders as text', async () => {
    const input = await render();
    await type(input, 'onerror');
    expect(options().map((node) => node.querySelector('.palette-option-title')?.textContent)).toEqual([payload, payload]);
    expect(document.querySelector('.palette-results img')).toBeNull();
  });

  test('arrow keys move the highlight across groups and wrap', async () => {
    const input = await render();
    expect(selected()?.dataset.key).toBe('task:t1');
    await key(input, 'ArrowDown');
    await key(input, 'ArrowDown');
    expect(selected()?.dataset.key).toBe('requirement:r1');
    expect(input.getAttribute('aria-activedescendant')).toBe(selected()?.id);
    await key(input, 'ArrowUp');
    await key(input, 'ArrowUp');
    await key(input, 'ArrowUp');
    expect(selected()?.dataset.key).toBe('requirement:r2');
  });

  test('typing filters and resets the highlight to the first result', async () => {
    const input = await render();
    await key(input, 'ArrowDown');
    await type(input, '验证');
    expect(options().map((node) => node.dataset.key)).toEqual(['setting:commands']);
    expect(selected()?.dataset.key).toBe('setting:commands');
    await type(input, 'zzz');
    expect(options()).toHaveLength(0);
    expect(document.querySelector('.palette-empty')?.textContent).toBe('没有匹配的结果');
  });

  test('Enter on a work package opens it in the execution view', async () => {
    const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
    const input = await render();
    await key(input, 'Enter');
    expect(open).toHaveBeenCalledWith('t1');
    expect(usePaletteStore().visible).toBe(false);
  });

  test('clicking a requirement opens it in the requirement center', async () => {
    const open = vi.spyOn(useRequirementsStore(), 'open').mockResolvedValue();
    const input = await render();
    await type(input, '邮箱');
    document.querySelector<HTMLElement>('[data-key="requirement:r1"]')!.click();
    await flushPromises();
    expect(open).toHaveBeenCalledWith({ id: 'r1' });
  });

  test('a settings page opens that page', async () => {
    const open = vi.spyOn(useSettingsStore(), 'open').mockResolvedValue();
    const input = await render();
    await type(input, 'avatar');
    await key(input, 'Enter');
    expect(open).toHaveBeenCalledWith('profile');
  });

  test("Escape closes, stays out of App's handler, and returns focus to the trigger", async () => {
    const appHandler = vi.fn();
    document.addEventListener('keydown', appHandler);
    const input = await render();
    await key(input, 'Escape');
    document.removeEventListener('keydown', appHandler);
    expect(appHandler).not.toHaveBeenCalled();
    expect(usePaletteStore().visible).toBe(false);
    expect(openDialogs.value).toBe(0);
    expect(document.activeElement).toBe(trigger);
  });

  test('⌘K and Ctrl+K toggle the palette; the listener goes away on unmount', async () => {
    wrapper = mount(CommandPalette, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    const palette = usePaletteStore();
    await key(document, 'k', { metaKey: true });
    expect(palette.visible).toBe(true);
    await key(document, 'k', { ctrlKey: true });
    expect(palette.visible).toBe(false);
    wrapper.unmount();
    wrapper = null;
    await key(document, 'k', { metaKey: true });
    expect(palette.visible).toBe(false);
  });

  test('⌘K leaves an open confirm box alone', async () => {
    wrapper = mount(CommandPalette, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    openDialogs.value = 1;
    await key(document, 'k', { metaKey: true });
    expect(usePaletteStore().visible).toBe(false);
  });
});

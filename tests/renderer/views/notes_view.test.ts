// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import NotesView from '../../../src/renderer/src/views/NotesView.vue';
import NoteMarkdown from '../../../src/renderer/src/components/notes/NoteMarkdown.vue';
import { useNotesStore } from '../../../src/renderer/src/stores/notes.ts';
import { useRepositoriesStore } from '../../../src/renderer/src/stores/repositories.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as noteTypes from '../../../src/shared/ipc/notes.ts';

// KaTeX checks once, when it loads, that the page is not in quirks mode;
// happy-dom reports no compatMode at all, while the app page has a doctype.
vi.hoisted(() => Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true }));

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  confirmChoice: vi.fn(async () => 'accept'),
  openDialogs: { value: 0 },
}));

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const meta = (overrides: Partial<noteTypes.NoteMeta> = {}): noteTypes.NoteMeta => ({
  id: '用例要有断言.md',
  title: '用例要有断言',
  category: 'writing',
  course: null,
  concepts: [],
  tags: ['测试'],
  inlineTags: [],
  source: { repositoryId: 'r1', repositoryName: 'app', packageId: 'p1', packageTitle: '登录', file: 'src/a.ts', line: 4 },
  summary: null,
  summaryStale: false,
  links: [],
  excerpt: '没有 expect',
  createdAt: '2026-10-20T02:00:00Z',
  updatedAt: '2026-10-24T02:00:00Z',
  version: 'v1',
  frontmatterError: false,
  ...overrides,
});
const NOTE: noteTypes.Note = { ...meta(), body: '# 断言\n\n<b>没有 expect</b> 见 [[命名]] 和 [[不存在]]\n\n- [ ] 补上\n\n```ts\nconst a = 1\n```\n' };
const LINKING = meta({ id: '命名.md', title: '命名', category: null, tags: [], links: ['用例要有断言'], excerpt: '链接到断言', source: null, version: 'v9' });

const PROGRAMMING: noteTypes.NoteCourse = {
  id: 'programming',
  title: '编程',
  rubric: [
    { id: 'thinking', label: '思路', dimension: 'thinking' },
    { id: 'writing', label: '写法', dimension: 'writing' },
    { id: 'style', label: '风格', dimension: 'style' },
  ],
};
const OS: noteTypes.NoteCourse = {
  id: 'os',
  title: '操作系统',
  rubric: [
    { id: 'concurrency', label: '并发', dimension: 'thinking' },
    { id: 'syscalls', label: '系统调用', dimension: 'writing' },
  ],
};

let api: { businessTimeZone: string; notes: Record<string, ReturnType<typeof vi.fn>>; workspace: { openFile: ReturnType<typeof vi.fn> } };
const list = (notes: noteTypes.NoteMeta[]): noteTypes.NoteList => ({
  revision: 1,
  directory: '/notes',
  custom: false,
  unavailable: null,
  truncated: false,
  notes,
});

const mountView = async (notes: noteTypes.NoteMeta[]) => {
  api.notes.list.mockImplementation(() => ok(list(notes)));
  const pinia = createPinia();
  setActivePinia(pinia);
  useRepositoriesStore().currentId = 'r1';
  const wrapper = mount(NotesView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  // Tests refresh by hand; a background poll would race them.
  useNotesStore().stopPolling();
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  document.body.replaceChildren();
  api = {
    businessTimeZone: 'Asia/Shanghai',
    notes: {
      list: vi.fn(() => ok(list([]))),
      get: vi.fn((id: string) => ok(id === NOTE.id ? NOTE : { ...LINKING, body: '[[用例要有断言]]' })),
      search: vi.fn(() => ok([])),
      create: vi.fn((input: noteTypes.NoteInput) =>
        ok({ revision: 2, relinked: 0, note: { ...meta({ id: `${input.title}.md`, title: input.title, source: null }), body: input.body } }),
      ),
      update: vi.fn((id: string, edit: noteTypes.NoteEdit) =>
        ok({ revision: 2, relinked: 1, note: { ...NOTE, ...edit, id: `${edit.title}.md`, version: 'v2', summary: edit.summary ?? null } }),
      ),
      remove: vi.fn(() => ok(true)),
      summarize: vi.fn(() => ok({ revision: 3, relinked: 0, note: { ...NOTE, summary: '测试必须有断言', version: 'v3' } })),
      pickDirectory: vi.fn(() => ok(null)),
      setDirectory: vi.fn(),
      reveal: vi.fn(() => ok(true)),
      openUrl: vi.fn(() => ok(true)),
      courses: vi.fn(() => ok<noteTypes.NoteCourses>({ current: 'programming', packs: [PROGRAMMING] })),
    },
    workspace: { openFile: vi.fn(() => ok('vscode')) },
  };
  Object.defineProperty(window, 'taskpilot', { value: api, configurable: true, writable: true });
});

const openFirst = async (wrapper: Awaited<ReturnType<typeof mountView>>) => {
  await wrapper.get('[data-note="用例要有断言.md"] .post-title').trigger('click');
  await flushPromises();
};

describe('NotesView', () => {
  test('with no notes it says how to get one', async () => {
    const wrapper = await mountView([]);
    expect(wrapper.get('[data-notes-empty]').text()).toContain('存为笔记');
  });

  test('the index lists notes by month with their date, category and tags', async () => {
    const wrapper = await mountView([meta({ createdAt: '2026-10-24T02:00:00Z' }), { ...LINKING, createdAt: '2026-09-30T20:00:00Z' }]);
    // 2026-09-30T20:00Z is already October in Shanghai.
    expect(wrapper.findAll('.post-group h3').map((heading) => heading.text())).toEqual(['2026 年 10 月']);
    const item = wrapper.get('[data-note="用例要有断言.md"]');
    expect(item.get('time').text()).toBe('2026-10-24');
    expect(item.text()).toContain('写法');
    expect(item.text()).toContain('#测试');
    await item.get('.post-tag').trigger('click');
    await flushPromises();
    expect(useNotesStore().filter.tag).toBe('测试');
    expect(wrapper.find('[data-note="命名.md"]').exists()).toBe(false);
  });

  test("with an OS repository the side lists OS's rubric and the shared dimensions; an unknown category shows its id", async () => {
    api.notes.courses.mockImplementation(() => ok<noteTypes.NoteCourses>({ current: 'os', packs: [PROGRAMMING, OS] }));
    const wrapper = await mountView([
      meta({ id: 'os.md', title: 'os', category: 'concurrency', course: 'os' }),
      meta({ id: 'old.md', title: 'old', category: 'thinking' }),
      meta({ id: 'odd.md', title: 'odd', category: 'knife', course: 'cooking' }),
    ]);
    const rubric = wrapper.get('[data-notes-rubric]');
    expect(rubric.get('h4').text()).toBe('分类 · 操作系统');
    expect(rubric.findAll('li').map((item) => item.text())).toEqual(['并发1', '系统调用0']);
    expect(
      wrapper
        .get('[data-notes-dimensions]')
        .findAll('li')
        .map((item) => item.text()),
    ).toEqual(['思路2', '写法0', '风格0']);
    expect(wrapper.get('[data-note="odd.md"] .post-category').text()).toBe('knife（未知维度）');
    expect(wrapper.get('[data-note="os.md"] .post-category').text()).toBe('并发');

    await wrapper.get('[data-notes-dimensions] li a').trigger('click');
    await flushPromises();
    expect(wrapper.get('.blog-filter-line').text()).toContain('思路（通用维度）');
    expect(wrapper.findAll('.post-item').map((item) => item.attributes('data-note'))).toEqual(['os.md', 'old.md']);
  });

  test('a note opens as its own page, rendering Markdown as nodes, never as markup, with its backlinks', async () => {
    const wrapper = await mountView([meta(), LINKING]);
    await openFirst(wrapper);
    expect(wrapper.find('.blog-index').exists()).toBe(false);
    expect(wrapper.get('.article-head h1').text()).toBe('用例要有断言');
    const preview = wrapper.get('[data-note-preview]');
    expect(preview.find('h1').text()).toBe('断言');
    expect(preview.find('b').exists()).toBe(false);
    expect(preview.text()).toContain('<b>没有 expect</b>');
    expect(preview.find('.hljs-keyword').text()).toBe('const');
    expect(preview.find('a.wiki-link:not(.missing)').text()).toBe('命名');
    expect(preview.find('a.wiki-link.missing').text()).toBe('不存在');
    expect(wrapper.get('[data-backlinks]').text()).toContain('命名');
    await wrapper.get('.article-source .blog-link').trigger('click');
    expect(api.workspace.openFile).toHaveBeenCalledWith('src/a.ts', 4);
  });

  test('a [[link]] goes to that note’s page, and back returns', async () => {
    const wrapper = await mountView([meta(), LINKING]);
    await openFirst(wrapper);
    await wrapper.get('a.wiki-link:not(.missing)').trigger('click');
    await flushPromises();
    expect(wrapper.get('.article-head h1').text()).toBe('命名');
    await wrapper.get('[data-action="back"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.article-head h1').text()).toBe('用例要有断言');
    await wrapper.get('[data-action="back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.blog-index').exists()).toBe(true);
  });

  test('a missing [[link]] is created after asking and opens in the editor', async () => {
    const wrapper = await mountView([meta(), LINKING]);
    await openFirst(wrapper);
    await wrapper.get('a.wiki-link.missing').trigger('click');
    await flushPromises();
    expect(api.notes.create).toHaveBeenCalledWith({ title: '不存在', body: '', category: null, tags: [], source: null }, false);
    expect(useNotesStore().current?.title).toBe('不存在');
    expect(wrapper.find('[data-note-editor]').exists()).toBe(true);
  });

  test('ticking a task saves it at once', async () => {
    const wrapper = await mountView([meta(), LINKING]);
    await openFirst(wrapper);
    await wrapper.get('.note-task input').trigger('change');
    await flushPromises();
    expect(api.notes.update).toHaveBeenCalledWith(
      '用例要有断言.md',
      expect.objectContaining({ body: expect.stringContaining('- [x] 补上'), baseVersion: 'v1' }),
    );
    // IPC structured-clones its arguments, which reactive proxies fail.
    expect(() => structuredClone(api.notes.update.mock.calls[0][1])).not.toThrow();
  });

  test('editing a rename asks to update links, then returns to reading', async () => {
    const wrapper = await mountView([meta(), LINKING]);
    await openFirst(wrapper);
    await wrapper.get('[data-action="edit-note"]').trigger('click');
    await flushPromises();
    await wrapper.get('.note-title-input').setValue('断言');
    await wrapper.get('[data-action="save-note"]').trigger('click');
    await flushPromises();
    expect(feedback.confirmChoice).toHaveBeenCalled();
    expect(api.notes.update).toHaveBeenCalledWith(
      '用例要有断言.md',
      expect.objectContaining({ title: '断言', baseVersion: 'v1', renameLinks: true, force: false }),
    );
    expect(useNotesStore().notes.map((entry) => entry.id)).toEqual(['断言.md', '命名.md']);
    expect(wrapper.find('[data-note-editor]').exists()).toBe(false);
    expect(wrapper.get('.article-head h1').text()).toBe('断言');
  });

  test('the editor switches between source, split and preview, and remembers the choice', async () => {
    localStorage.removeItem('taskpilot.noteEditorMode');
    const wrapper = await mountView([meta()]);
    await openFirst(wrapper);
    await wrapper.get('[data-action="edit-note"]').trigger('click');
    await flushPromises();
    const editor = wrapper.get('[data-note-editor]');
    expect(editor.find('.note-textarea').exists()).toBe(true);
    expect(editor.find('[data-note-preview]').exists()).toBe(true);
    const pick = async (label: string) => {
      await wrapper
        .findAll('[data-note-mode] .el-segmented__item')
        .find((item) => item.text() === label)!
        .trigger('click');
      await flushPromises();
    };
    await pick('源码');
    expect(editor.find('[data-note-preview]').exists()).toBe(false);
    expect(localStorage.getItem('taskpilot.noteEditorMode')).toBe('source');
    await pick('预览');
    expect(editor.find('.note-textarea').exists()).toBe(false);
    expect(editor.get('[data-note-preview]').classes()).toContain('alone');
    await editor.trigger('keydown', { key: 'e', metaKey: true });
    await flushPromises();
    expect(editor.find('.note-textarea').exists()).toBe(true);
    expect(editor.find('[data-note-preview]').exists()).toBe(false);
    expect(localStorage.getItem('taskpilot.noteEditorMode')).toBe('source');
    localStorage.removeItem('taskpilot.noteEditorMode');
  });

  test('leaving unsaved edits asks first', async () => {
    const wrapper = await mountView([meta()]);
    await openFirst(wrapper);
    await wrapper.get('[data-action="edit-note"]').trigger('click');
    await flushPromises();
    useNotesStore().draft!.body = '改了';
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await wrapper.get('[data-action="notes-home"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-note-editor]').exists()).toBe(true);
  });

  test('a file changed elsewhere while editing offers to keep or drop the edits', async () => {
    const wrapper = await mountView([meta()]);
    await openFirst(wrapper);
    await wrapper.get('[data-action="edit-note"]').trigger('click');
    await flushPromises();
    const store = useNotesStore();
    store.draft!.body = '我的修改';
    api.notes.list.mockImplementation(() => ok({ ...list([meta({ version: 'v5' })]), revision: 7 }));
    await store.refresh();
    await flushPromises();
    expect(wrapper.find('[data-note-conflict]').exists()).toBe(true);
    expect(store.draft!.body).toBe('我的修改');
    await wrapper.get('[data-action="discard-mine"]').trigger('click');
    await flushPromises();
    expect(store.draft!.body).toBe(NOTE.body);
    expect(wrapper.find('[data-note-conflict]').exists()).toBe(false);
  });

  test('Tutor writes the summary on request', async () => {
    const wrapper = await mountView([meta()]);
    await openFirst(wrapper);
    await wrapper.get('[data-action="edit-note"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-action="summarize"]').trigger('click');
    await flushPromises();
    expect(api.notes.summarize).toHaveBeenCalledWith('用例要有断言.md', 'v1');
    expect(useNotesStore().draft!.summary).toBe('测试必须有断言');
  });

  test('deleting asks first and goes back', async () => {
    const wrapper = await mountView([meta()]);
    await openFirst(wrapper);
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await wrapper.get('[data-action="delete-note"]').trigger('click');
    await flushPromises();
    expect(api.notes.remove).not.toHaveBeenCalled();
    await wrapper.get('[data-action="delete-note"]').trigger('click');
    await flushPromises();
    expect(api.notes.remove).toHaveBeenCalledWith('用例要有断言.md');
    expect(useNotesStore().notes).toEqual([]);
    expect(wrapper.find('.blog-index').exists()).toBe(true);
  });
});

describe('NoteMarkdown', () => {
  test('links open only web and mail addresses; raw HTML and images stay text', async () => {
    const wrapper = mount(NoteMarkdown, {
      props: { body: '[web](https://example.com) [bad](javascript:alert(1)) ![pic](https://x/y.png)\n\n<script>x</script>\n', exists: () => false },
    });
    const links = wrapper.findAll('a.external-link');
    await links[0].trigger('click');
    await links[1].trigger('click');
    expect(wrapper.emitted('open-url')).toEqual([['https://example.com']]);
    expect(links.every((link) => link.attributes('href') === undefined)).toBe(true);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<script>x</script>');
  });

  test('$inline$ and $$display$$ math is typeset by KaTeX; links in TeX stay inert and bad TeX shows its source', async () => {
    const wrapper = mount(NoteMarkdown, {
      props: {
        body: '令 $\\sigma(z)$ 为 sigmoid：\n\n$$\n\\sigma(z)=\\frac{1}{1+e^{-z}}\n$$\n\n$\\href{javascript:alert(1)}{x}$ 和 $\\frac{1$\n',
        exists: () => false,
      },
    });
    await flushPromises();
    expect(wrapper.find('.note-math-inline .katex').exists()).toBe(true);
    expect(wrapper.find('.note-math-display .katex-display').exists()).toBe(true);
    expect(wrapper.find('.katex mfrac').exists()).toBe(true);
    // Untrusted, KaTeX prints \\href as red text instead of making a link.
    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.findAll('.note-math-error').map((error) => error.text())).toEqual(['\\frac{1']);
  });

  test('tables, quotes and #tags render', async () => {
    const wrapper = mount(NoteMarkdown, { props: { body: '> 引用 #习惯\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', exists: () => true } });
    expect(wrapper.find('blockquote').text()).toContain('引用');
    expect(wrapper.findAll('th').map((cell) => cell.text())).toEqual(['a', 'b']);
    expect(wrapper.findAll('td').map((cell) => cell.text())).toEqual(['1', '2']);
    await wrapper.get('a.note-tag').trigger('click');
    expect(wrapper.emitted('open-tag')).toEqual([['习惯']]);
  });
});

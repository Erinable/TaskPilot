// The title rules on their own: the renderer reads them without the Markdown
// parser, and note_markdown.ts keeps serving the same functions to main.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import * as markdown from '../../src/shared/note_markdown.ts';
import * as title from '../../src/shared/note_title.ts';

test('titles must work as file names and inside [[links]]', () => {
  expect(title.titleProblem('变量命名')).toBeNull();
  for (const bad of ['', ' a', 'a/b', 'a:b', 'a#b', 'a|b', '[a]', '.hidden', 'x'.repeat(title.MAX_TITLE + 1)])
    expect(title.titleProblem(bad), bad).not.toBeNull();
  expect(title.toTitle('  a/b: c#d  ')).toBe('a b c d');
  expect(title.toTitle('...')).toBe('未命名');
  expect([...title.toTitle('长'.repeat(200))]).toHaveLength(title.MAX_TITLE);
  expect(title.titleKey('  Old Note ')).toBe('old note');
});

test('note_markdown.ts re-exports the same title rules', () => {
  expect(markdown.titleKey).toBe(title.titleKey);
  expect(markdown.toTitle).toBe(title.toTitle);
  expect(markdown.titleProblem).toBe(title.titleProblem);
  expect(markdown.MAX_TITLE).toBe(title.MAX_TITLE);
});

test('the title rules import nothing, so they never pull the Markdown parser into a bundle', () => {
  expect(readFileSync(new URL('../../src/shared/note_title.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
});

test('the renderer reads titles from note_title.ts, not from the Markdown module', () => {
  for (const file of ['stores/notes.ts', 'lib/notes_model.ts', 'views/NotesView.vue'])
    expect(readFileSync(new URL(`../../src/renderer/src/${file}`, import.meta.url), 'utf8'), file).not.toContain('note_markdown');
});

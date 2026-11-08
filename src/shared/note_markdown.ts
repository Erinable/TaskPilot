// Markdown in learning notes, shared by the main process (backlinks, renames)
// and the renderer (preview). A note body is Markdown with GitHub extensions,
// $inline$ and $$display$$ math as in Obsidian, plus Obsidian's [[wiki
// links]] and #tags; neither is recognised inside code or math.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Nodes, Root } from 'mdast';

import { titleKey } from './note_title.ts';

// Title rules live in note_title.ts, which has no parser behind it; they are
// re-exported for the main process, which reads both.
export { MAX_TITLE, titleKey, titleProblem, toTitle } from './note_title.ts';

// singleDollarTextMath: $x$ is math, as in Obsidian.
export const parseMarkdown = (body: string): Root =>
  fromMarkdown(body, { extensions: [gfm(), math({ singleDollarTextMath: true })], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });

export const plainText = (node: Nodes): string =>
  'value' in node && typeof node.value === 'string' ? node.value : 'children' in node ? node.children.map((child) => plainText(child)).join('') : '';

// [[target#heading|alias]]; the target is everything before # or |.
export const WIKI_LINK = /\[\[([^[\]\n]+?)\]\]/g;
// #tag after a space or at the start; letters, digits, _ - /, not only digits.
export const INLINE_TAG = /(?<![\p{L}\p{N}_&#/])#([\p{L}\p{N}_/-]+)/gu;

export type WikiLink = { target: string; heading: string | null; alias: string | null };
export type FoundLink = WikiLink & { start: number; end: number; targetStart: number; targetEnd: number };
export type Heading = { depth: number; text: string; line: number };
export type BodyScan = { links: FoundLink[]; tags: string[]; headings: Heading[] };

export const splitLink = (inner: string): WikiLink => {
  const pipe = inner.indexOf('|');
  const head = pipe === -1 ? inner : inner.slice(0, pipe);
  const hash = head.indexOf('#');
  return {
    target: (hash === -1 ? head : head.slice(0, hash)).trim(),
    heading: hash === -1 ? null : head.slice(hash + 1).trim() || null,
    alias: pipe === -1 ? null : inner.slice(pipe + 1).trim() || null,
  };
};

export const isTag = (name: string) => !/^[\d/_-]+$/.test(name);

// The text of a link as it reads: its alias, or the target and heading.
export const linkLabel = (link: WikiLink) => link.alias ?? (link.heading ? `${link.target} › ${link.heading}` : link.target);

// Plain text of a node with inline math left out (TeX source reads badly).
const proseText = (node: Nodes): string =>
  node.type === 'inlineMath' ? '' : 'children' in node ? node.children.map((child) => proseText(child)).join('') : plainText(node);

// The note's prose as one line of plain text, blocks separated by spaces.
// Code, math, tables and a heading that only repeats the title are left out.
export const excerptOf = (tree: Root, title: string | null = null): string =>
  tree.children
    .filter((node, index) => !(index === 0 && node.type === 'heading' && title !== null && titleKey(plainText(node)) === titleKey(title)))
    .filter((node) => node.type !== 'code' && node.type !== 'math' && node.type !== 'table' && node.type !== 'html')
    .map((node) => proseText(node))
    .join(' ')
    .replace(WIKI_LINK, (_whole, inner: string) => linkLabel(splitLink(inner)))
    .replace(/\s+/g, ' ')
    .trim();

// Text nodes outside code and Markdown links, with where they sit in the body.
const visitText = (node: Nodes, body: string, visit: (raw: string, offset: number) => void) => {
  if (node.type === 'text' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
    visit(body.slice(node.position.start.offset, node.position.end.offset), node.position.start.offset);
    return;
  }
  if (node.type === 'link' || node.type === 'linkReference') return;
  if ('children' in node) for (const child of node.children) visitText(child, body, visit);
};

export const scanBody = (body: string, tree: Root = parseMarkdown(body)): BodyScan => {
  const links: FoundLink[] = [];
  const tags = new Set<string>();
  visitText(tree, body, (raw, offset) => {
    for (const match of raw.matchAll(WIKI_LINK)) {
      const link = splitLink(match[1]);
      if (!link.target) continue;
      const start = offset + match.index;
      const targetStart = start + 2 + match[1].indexOf(link.target);
      links.push({ ...link, start, end: start + match[0].length, targetStart, targetEnd: targetStart + link.target.length });
    }
    for (const match of raw.replace(WIKI_LINK, (whole) => ' '.repeat(whole.length)).matchAll(INLINE_TAG)) if (isTag(match[1])) tags.add(match[1]);
  });
  const headings = tree.children.flatMap((node) =>
    node.type === 'heading' ? [{ depth: node.depth, text: plainText(node).trim(), line: node.position?.start.line ?? 1 }] : [],
  );
  return { links, tags: [...tags], headings };
};

// Points every [[from]] (any case, with or without #heading or |alias) at
// `to`; returns the body unchanged when nothing links to `from`.
export const renameLinks = (body: string, from: string, to: string): string => {
  const key = titleKey(from);
  const hits = scanBody(body).links.filter((link) => titleKey(link.target) === key);
  let next = body;
  for (const link of hits.reverse()) next = `${next.slice(0, link.targetStart)}${to}${next.slice(link.targetEnd)}`;
  return next;
};

<script lang="ts">
// Renders a note's Markdown by building Vue nodes from its syntax tree, so
// no text ever becomes markup (the page never sets HTML from strings). [[links]] and
// #tags are found in text outside code; code blocks are highlighted by
// lowlight, whose output is a tree as well. Links carry no href: a click is
// handled here, so the window never navigates.
import { common, createLowlight } from 'lowlight';
import { defineComponent, h } from 'vue';
import type { PropType, VNode, VNodeArrayChildren } from 'vue';
import type { ElementContent, RootContent as HastContent } from 'hast';
import type { Nodes, Root } from 'mdast';

import NoteChart from '@/components/notes/NoteChart.vue';
import NoteMath from '@/components/notes/NoteMath.vue';
import { isChartLanguage } from '@/lib/note_charts.ts';
import * as markdown from '@shared/note_markdown.ts';

const lowlight = createLowlight(common);
// Highlighting a huge block would stall typing in the split view.
const MAX_HIGHLIGHT = 20_000;
const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

// A heading's anchor, by its line, so the outline can scroll to it.
export const headingAnchor = (line: number) => `note-heading-${line}`;

export default defineComponent({
  name: 'NoteMarkdown',
  props: {
    body: { type: String, required: true },
    // Resolves a [[target]] to whether a note with that title exists.
    exists: { type: Function as PropType<(title: string) => boolean>, required: true },
  },
  emits: {
    'open-link': (_link: markdown.WikiLink) => true,
    'open-url': (_url: string) => true,
    'open-tag': (_tag: string) => true,
    'toggle-task': (_offset: number) => true,
  },
  setup(props, { emit }) {
    const highlighted = (code: string, lang: string | null | undefined): VNodeArrayChildren => {
      if (!lang || code.length > MAX_HIGHLIGHT || !lowlight.registered(lang)) return [code];
      const toVNode = (node: HastContent | ElementContent): VNode | string => {
        if (node.type === 'text') return node.value;
        if (node.type !== 'element') return '';
        const className = node.properties?.className;
        return h('span', { class: Array.isArray(className) ? className.join(' ') : undefined }, node.children.map(toVNode));
      };
      try {
        return lowlight.highlight(lang, code).children.map(toVNode);
      } catch (error) {
        console.error('[notes] highlight failed', error);
        return [code];
      }
    };

    // Plain text with [[links]] and #tags turned into clickable spans.
    const inline = (text: string): VNodeArrayChildren => {
      const parts: VNodeArrayChildren = [];
      const pattern = new RegExp(`${markdown.WIKI_LINK.source}|${markdown.INLINE_TAG.source}`, 'gu');
      let last = 0;
      for (const match of text.matchAll(pattern)) {
        if (match[1] === undefined && !markdown.isTag(match[2])) continue;
        parts.push(text.slice(last, match.index));
        last = match.index + match[0].length;
        if (match[1] !== undefined) {
          const link = markdown.splitLink(match[1]);
          const found = link.target ? props.exists(link.target) : false;
          parts.push(
            h(
              'a',
              {
                class: ['wiki-link', { missing: !found }],
                role: 'link',
                tabindex: 0,
                title: found ? link.target : `「${link.target}」还不存在，点击新建`,
                onClick: () => emit('open-link', link),
                onKeydown: (event: KeyboardEvent) => event.key === 'Enter' && emit('open-link', link),
              },
              markdown.linkLabel(link),
            ),
          );
        } else {
          const tag = match[2];
          parts.push(h('a', { class: 'note-tag', role: 'link', tabindex: 0, onClick: () => emit('open-tag', tag) }, `#${tag}`));
        }
      }
      parts.push(text.slice(last));
      return parts.filter((part) => part !== '');
    };

    const children = (node: Nodes): VNodeArrayChildren => ('children' in node ? node.children.map((child) => render(child)) : []);

    // A paragraph right after a chart that starts with 图 N / Figure N is its
    // caption, as in a journal: the two render as one figure.
    const CAPTION = /^(图|Fig\.?|Figure)\s*\d+/;
    const isCaption = (node: Nodes | undefined) => node?.type === 'paragraph' && CAPTION.test(markdown.plainText(node).trim());
    const blocks = (nodes: Nodes[]): VNodeArrayChildren => {
      const out: VNodeArrayChildren = [];
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.type === 'code' && isChartLanguage(node.lang)) {
          const caption = isCaption(nodes[index + 1]) ? nodes[(index += 1)] : null;
          out.push(
            h('figure', { class: 'note-figure' }, [
              h(NoteChart, { lang: node.lang, source: node.value }),
              caption && 'children' in caption ? h('figcaption', children(caption)) : null,
            ]),
          );
        } else out.push(render(node));
      }
      return out;
    };

    const render = (node: Nodes): VNode | string | VNodeArrayChildren => {
      switch (node.type) {
        case 'root':
          return blocks(node.children);
        case 'paragraph':
          return h('p', children(node));
        case 'heading':
          return h(`h${node.depth}`, { id: headingAnchor(node.position?.start.line ?? 0) }, children(node));
        case 'text':
          return inline(node.value);
        case 'emphasis':
          return h('em', children(node));
        case 'strong':
          return h('strong', children(node));
        case 'delete':
          return h('del', children(node));
        case 'inlineCode':
          return h('code', node.value);
        case 'inlineMath':
          return h(NoteMath, { tex: node.value });
        case 'math':
          return h(NoteMath, { tex: node.value, display: true });
        case 'code':
          return h('pre', { class: 'note-code' }, [
            h('code', { class: node.lang ? `hljs language-${node.lang}` : 'hljs' }, highlighted(node.value, node.lang)),
          ]);
        case 'blockquote':
          return h('blockquote', children(node));
        case 'list':
          return h(
            node.ordered ? 'ol' : 'ul',
            {
              start: node.ordered && node.start !== 1 ? node.start : undefined,
              class: { 'task-list': node.children.some((item) => item.checked !== null && item.checked !== undefined) },
            },
            children(node),
          );
        case 'listItem': {
          if (node.checked === null || node.checked === undefined) return h('li', children(node));
          const offset = node.position?.start.offset ?? 0;
          return h('li', { class: 'note-task' }, [
            h('input', {
              type: 'checkbox',
              checked: node.checked,
              'aria-label': node.checked ? '标记为未完成' : '标记为完成',
              onChange: () => emit('toggle-task', offset),
            }),
            ...children(node),
          ]);
        }
        case 'thematicBreak':
          return h('hr');
        case 'break':
          return h('br');
        case 'link': {
          const url = node.url;
          const safe = SAFE_PROTOCOLS.test(url);
          return h(
            'a',
            {
              class: ['external-link', { unsafe: !safe }],
              role: 'link',
              tabindex: 0,
              title: url,
              onClick: () => safe && emit('open-url', url),
              onKeydown: (event: KeyboardEvent) => event.key === 'Enter' && safe && emit('open-url', url),
            },
            children(node),
          );
        }
        case 'image':
          // The page loads no outside images; the alt text stands in.
          return h('span', { class: 'note-image', title: node.url }, `🖼 ${node.alt || node.url}`);
        case 'table':
          return h('div', { class: 'note-table' }, [
            h('table', [
              h('thead', [h('tr', node.children[0]?.children.map((cell) => h('th', children(cell))) ?? [])]),
              h(
                'tbody',
                node.children.slice(1).map((row) => render(row)),
              ),
            ]),
          ]);
        case 'tableRow':
          return h('tr', children(node));
        case 'tableCell':
          return h('td', children(node));
        case 'footnoteReference':
          return h('sup', `[${node.label ?? node.identifier}]`);
        case 'footnoteDefinition':
          return h('div', { class: 'note-footnote' }, [h('sup', `[${node.label ?? node.identifier}]`), ...children(node)]);
        case 'html':
          // Raw HTML in a note is shown as the text it is.
          return h('code', { class: 'note-raw' }, node.value);
        default:
          return 'value' in node && typeof node.value === 'string' ? node.value : children(node);
      }
    };

    return () => h('div', { class: 'note-markdown' }, render(markdown.parseMarkdown(props.body) as Root) as VNodeArrayChildren);
  },
});
</script>

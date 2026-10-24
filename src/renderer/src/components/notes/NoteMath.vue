<script lang="ts">
// One formula in a note, typeset by KaTeX. katex.render builds DOM nodes
// itself (no markup from strings, and its sizes are set through the style
// object, which the page CSP allows). Trust is off so \href, \url,
// \includegraphics and \html… stay inert, and strict mode refuses
// non-LaTeX input. A formula KaTeX cannot parse is shown as its source.
//
// [人工决策-2026-10-24 18:33:17] 笔记公式用 KaTeX 渲染，必须保持 trust: false。
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { defineComponent, h, onMounted, onUpdated, ref } from 'vue';

export default defineComponent({
  name: 'NoteMath',
  props: {
    tex: { type: String, required: true },
    display: { type: Boolean, default: false },
  },
  setup(props) {
    const element = ref<HTMLElement | null>(null);
    const failed = ref<string | null>(null);
    const paint = () => {
      const target = element.value;
      if (!target) return;
      try {
        katex.render(props.tex, target, { displayMode: props.display, throwOnError: true, trust: false, strict: 'error', maxSize: 20, maxExpand: 500 });
        failed.value = null;
      } catch (error) {
        target.textContent = props.tex;
        failed.value = error instanceof Error ? error.message : String(error);
      }
    };
    onMounted(paint);
    onUpdated(paint);
    // The key re-creates the element when the source changes; paint() fills it.
    return () =>
      h(props.display ? 'div' : 'span', {
        ref: element,
        key: `${props.display}:${props.tex}`,
        class: [props.display ? 'note-math-display' : 'note-math-inline', { 'note-math-error': failed.value }],
        title: failed.value ?? undefined,
      });
  },
});
</script>

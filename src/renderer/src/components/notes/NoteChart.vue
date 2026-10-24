<script setup lang="ts">
// A chart code block in a note (```vega-lite, ```vega, ```mermaid, ```svg)
// drawn as a figure. A chart that fails shows why, with its source, so the
// note stays readable; nothing here ever inserts markup from a string.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import * as charts from '@/lib/note_charts.ts';

const props = defineProps<{ lang: charts.ChartLanguage; source: string }>();

const host = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
let vegaView: charts.VegaHandle | null = null;
// A newer source replaces a render still in flight.
let generation = 0;

const draw = async () => {
  const target = host.value;
  if (!target) return;
  const current = (generation += 1);
  vegaView?.finalize();
  vegaView = null;
  error.value = null;
  loading.value = true;
  try {
    if (props.lang === 'vega' || props.lang === 'vega-lite') {
      // Vega draws into a fresh child, so a failed redraw leaves nothing half-built.
      const canvas = document.createElement('div');
      const view = await charts.renderVega(canvas, props.source, props.lang);
      if (current !== generation) return view.finalize();
      target.shadowRoot?.replaceChildren();
      target.replaceChildren(canvas);
      vegaView = view;
    } else {
      const drawing = props.lang === 'mermaid' ? await charts.renderMermaid(props.source) : charts.sanitizeSvg(props.source);
      if (current !== generation) return;
      charts.mountSvg(target, drawing);
    }
  } catch (failure) {
    if (current !== generation) return;
    console.error(`[notes] ${props.lang} chart failed`, failure);
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (current === generation) loading.value = false;
  }
};

onMounted(() => draw().catch((failure) => console.error('[notes] chart failed', failure)));
watch(
  () => [props.lang, props.source],
  () => draw().catch((failure) => console.error('[notes] chart failed', failure)),
);
onBeforeUnmount(() => {
  generation += 1;
  vegaView?.finalize();
});
</script>

<template>
  <div class="note-chart" :class="[`note-chart-${lang}`, { failed: error }]" :data-chart="lang">
    <div v-show="!error" ref="host" class="note-chart-canvas" :aria-busy="loading" />
    <p v-if="loading && !error" class="note-chart-status">正在画图…</p>
    <div v-if="error" class="note-chart-error" role="alert">
      <strong>图没画出来：</strong>
      {{ error }}
      <pre><code>{{ source }}</code></pre>
    </div>
  </div>
</template>

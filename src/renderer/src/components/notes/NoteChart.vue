<script setup lang="ts">
// A chart code block in a note (```vega-lite, ```vega, ```mermaid, ```svg)
// drawn as a figure. A chart that fails shows why, with its source, so the
// note stays readable; nothing here ever inserts markup from a string.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import * as charts from '@/lib/note_charts.ts';

const props = defineProps<{ lang: charts.ChartLanguage; source: string }>();

const host = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
let vegaView: charts.VegaHandle | null = null;
// Sliders a play button can animate, and which one is chosen.
const playables = shallowRef<charts.Playable[]>([]);
const playing = ref<string | null>(null);
// One pass takes about PASS_MS in at most FRAMES steps (a slider with few
// stops, like training frames, gets one step per stop); the end holds a moment.
const FRAMES = 30;
const PASS_MS = 3000;
const HOLD_MS = 900;
let timer: number | null = null;

const stop = () => {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  playing.value = null;
};

// Steps a slider from where it is to its end, then starts over, until paused.
const play = (playable: charts.Playable) => {
  if (playing.value === playable.name) return stop();
  stop();
  const view = vegaView;
  if (!view) return;
  playing.value = playable.name;
  const span = playable.max - playable.min;
  const stride = Math.max(playable.step, Math.round(span / FRAMES / playable.step) * playable.step);
  const delay = Math.round(PASS_MS / Math.ceil(span / stride));
  const tick = async () => {
    if (playing.value !== playable.name || vegaView !== view) return;
    const current = view.get(playable.name);
    const next = current >= playable.max - playable.step / 2 ? playable.min : Math.min(playable.max, current + stride);
    await view.set(playable.name, Number(next.toFixed(6)));
    timer = window.setTimeout(() => tick().catch((error) => console.error('[notes] chart play failed', error)), next >= playable.max ? HOLD_MS : delay);
  };
  tick().catch((error) => console.error('[notes] chart play failed', error));
};
// A newer source replaces a render still in flight.
let generation = 0;

const draw = async () => {
  const target = host.value;
  if (!target) return;
  const current = (generation += 1);
  stop();
  vegaView?.finalize();
  vegaView = null;
  playables.value = [];
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
      playables.value = view.playables;
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
  stop();
  vegaView?.finalize();
});
</script>

<template>
  <div class="note-chart" :class="[`note-chart-${lang}`, { failed: error }]" :data-chart="lang">
    <div v-show="!error" ref="host" class="note-chart-canvas" :aria-busy="loading" />
    <div v-if="playables.length && !error" class="note-chart-play">
      <button
        v-for="playable in playables"
        :key="playable.name"
        class="secondary-button small"
        type="button"
        :aria-pressed="playing === playable.name"
        data-action="play-chart"
        @click="play(playable)"
      >
        <AppIcon :name="playing === playable.name ? 'pause' : 'play'" />
        {{ playing === playable.name ? '暂停' : playables.length > 1 ? `播放${playable.label}` : '播放' }}
      </button>
    </div>
    <p v-if="loading && !error" class="note-chart-status">正在画图…</p>
    <div v-if="error" class="note-chart-error" role="alert">
      <strong>图没画出来：</strong>
      {{ error }}
      <pre><code>{{ source }}</code></pre>
    </div>
  </div>
</template>

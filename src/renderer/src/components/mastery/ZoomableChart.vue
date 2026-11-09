<script setup lang="ts">
// A chart in a fixed-height viewport that can be zoomed and panned freely:
// the wheel (or a trackpad pinch) zooms around the pointer, dragging pans,
// and the toolbar zooms in and out, fits the whole chart, or shows it 1:1.
// Opens fitted, and fits again when the chart is redrawn at another size.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import NoteChart from '@/components/notes/NoteChart.vue';
import * as zoom from '@/lib/graph_zoom.ts';
import type { ChartLanguage } from '@/lib/note_charts.ts';

defineProps<{ lang: ChartLanguage; source: string; label: string }>();

const viewport = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const view = ref<zoom.View>({ scale: 1, x: 0, y: 0 });
const dragging = ref(false);
const STEP = 1.25;
let content: zoom.Size = { width: 0, height: 0 };
let drag: { pointerId: number; x: number; y: number } | null = null;

const percent = computed(() => `${Math.round(view.value.scale * 100)}%`);
const transform = computed(() => `translate(${view.value.x}px, ${view.value.y}px) scale(${view.value.scale})`);

const viewportSize = (): zoom.Size => ({ width: viewport.value?.clientWidth ?? 0, height: viewport.value?.clientHeight ?? 0 });
const settle = (next: zoom.View) => (view.value = zoom.clampPan(next, content, viewportSize()));

const fit = () => settle(zoom.fitView(content, viewportSize()));
const actualSize = () => settle({ scale: 1, x: zoom.fitView(content, viewportSize()).x, y: 16 });
const zoomBy = (factor: number) => {
  const size = viewportSize();
  settle(zoom.zoomAt(view.value, factor, size.width / 2, size.height / 2));
};

// The stage holds the chart at its natural size; its size changes only when
// a new drawing lands, and then the view fits it again.
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(() => {
    const width = stage.value?.offsetWidth ?? 0;
    const height = stage.value?.offsetHeight ?? 0;
    if (width === content.width && height === content.height) return;
    content = { width, height };
    fit();
  });
  if (stage.value) observer.observe(stage.value);
});
onBeforeUnmount(() => observer?.disconnect());

const onWheel = (event: WheelEvent) => {
  event.preventDefault();
  const box = viewport.value!.getBoundingClientRect();
  // A pinch arrives as a wheel with ctrlKey and small deltas; both map onto
  // the same exponential curve so a notch and a pinch feel alike.
  const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
  settle(zoom.zoomAt(view.value, factor, event.clientX - box.left, event.clientY - box.top));
};

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) return;
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  dragging.value = true;
  viewport.value?.setPointerCapture(event.pointerId);
};
const onPointerMove = (event: PointerEvent) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  settle({ ...view.value, x: view.value.x + event.clientX - drag.x, y: view.value.y + event.clientY - drag.y });
  drag = { ...drag, x: event.clientX, y: event.clientY };
};
const onPointerUp = (event: PointerEvent) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  dragging.value = false;
};

// Arrow keys pan, + and - zoom, 0 fits: the viewport is focusable.
const PAN = 48;
const onKeydown = (event: KeyboardEvent) => {
  const moves: Record<string, [number, number]> = { ArrowLeft: [PAN, 0], ArrowRight: [-PAN, 0], ArrowUp: [0, PAN], ArrowDown: [0, -PAN] };
  if (moves[event.key]) settle({ ...view.value, x: view.value.x + moves[event.key][0], y: view.value.y + moves[event.key][1] });
  else if (event.key === '+' || event.key === '=') zoomBy(STEP);
  else if (event.key === '-') zoomBy(1 / STEP);
  else if (event.key === '0') fit();
  else return;
  event.preventDefault();
};
</script>

<template>
  <div class="zoomable-chart" data-zoomable-chart>
    <div class="zoom-toolbar" role="toolbar" :aria-label="`${label}缩放`">
      <button class="icon-button small" type="button" title="缩小" aria-label="缩小" data-action="zoom-out" @click="zoomBy(1 / STEP)">
        <AppIcon name="minus" />
      </button>
      <button class="zoom-percent" type="button" title="按原尺寸显示" data-action="zoom-actual" @click="actualSize">{{ percent }}</button>
      <button class="icon-button small" type="button" title="放大" aria-label="放大" data-action="zoom-in" @click="zoomBy(STEP)">
        <AppIcon name="plus" />
      </button>
      <button class="icon-button small" type="button" title="适应窗口" aria-label="适应窗口" data-action="zoom-fit" @click="fit">
        <AppIcon name="fit" />
      </button>
    </div>
    <div
      ref="viewport"
      class="zoom-viewport"
      :class="{ dragging }"
      tabindex="0"
      role="img"
      :aria-label="`${label}，滚轮或双指缩放，拖动平移`"
      data-zoom-viewport
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <div ref="stage" class="zoom-stage" :style="{ transform }" data-zoom-stage>
        <NoteChart :lang="lang" :source="source" natural />
      </div>
    </div>
  </div>
</template>

<style scoped>
.zoomable-chart {
  position: relative;
}
.zoom-toolbar {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  box-shadow: var(--glass-shadow);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
}
.zoom-percent {
  min-width: 48px;
  height: 28px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.zoom-percent:hover {
  color: var(--text);
  background: var(--fill-hover);
}
.zoom-viewport {
  position: relative;
  height: 460px;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--fill);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.zoom-viewport.dragging {
  cursor: grabbing;
}
.zoom-viewport:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.zoom-stage {
  position: absolute;
  top: 0;
  left: 0;
  width: max-content;
  transform-origin: 0 0;
  will-change: transform;
}
</style>

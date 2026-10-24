<script setup lang="ts">
// The sidebar's right edge: drag to resize, double-click for the default
// width, arrow keys for keyboard users. Dragging past the collapse
// threshold folds the sidebar to its icon rail.
import { ref } from 'vue';

import { COLLAPSE_BELOW, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '@/lib/sidebar_layout.ts';
import { useAppStore } from '@/stores/app.ts';

const app = useAppStore();
const dragging = ref(false);
const KEY_STEP = 16;

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  // The width is the pointer's distance from the sidebar's left edge.
  const left = handle.parentElement?.getBoundingClientRect().left ?? 0;
  dragging.value = true;
  document.documentElement.classList.add('resizing-sidebar');
  const onMove = (move: PointerEvent) => app.resizeSidebar(move.clientX - left);
  const onUp = () => {
    dragging.value = false;
    document.documentElement.classList.remove('resizing-sidebar');
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    app.saveSidebarLayout();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const current = app.sidebarCollapsed ? COLLAPSE_BELOW - 1 : app.sidebarWidth;
  const step = event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP;
  // From the rail, one step right reopens at the narrowest width.
  app.resizeSidebar(app.sidebarCollapsed && step > 0 ? MIN_SIDEBAR_WIDTH : current + step);
  app.saveSidebarLayout();
};
</script>

<template>
  <div
    class="sidebar-resizer"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    aria-label="调整侧栏宽度（双击恢复默认）"
    :aria-valuemin="MIN_SIDEBAR_WIDTH"
    :aria-valuemax="MAX_SIDEBAR_WIDTH"
    :aria-valuenow="app.sidebarCollapsed ? 0 : app.sidebarWidth"
    tabindex="0"
    title="拖动调整宽度，双击恢复默认"
    data-sidebar-resizer
    @pointerdown="onPointerDown"
    @dblclick="app.resetSidebarWidth()"
    @keydown="onKeydown"
  />
</template>

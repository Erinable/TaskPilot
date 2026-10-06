// Command palette visibility, and where focus goes back to when it closes.
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const usePaletteStore = defineStore('palette', () => {
  // ========== Visibility ==========
  const visible = ref(false);
  let trigger: HTMLElement | null = null;

  // Remembers the focused element (the 搜索 button, or whatever had focus for ⌘K).
  const openPalette = () => {
    if (visible.value) return;
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visible.value = true;
  };

  // The trigger stays mounted (top bar, or the view that had focus), so focus
  // goes back to it even after an action navigates.
  const closePalette = () => {
    if (!visible.value) return;
    visible.value = false;
    trigger?.focus();
    trigger = null;
  };

  const togglePalette = () => (visible.value ? closePalette() : openPalette());

  return {
    // Visibility
    visible,
    openPalette,
    closePalette,
    togglePalette,
  };
});

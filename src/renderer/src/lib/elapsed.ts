// How long AI work has been running, in plain words, and a clock that ticks
// while a component shows it.
import { onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue';
import type { MaybeRefOrGetter } from 'vue';

// "45 秒", "3 分 12 秒", "1 小时 5 分".
export const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};

export const elapsedSince = (startedAt: string | null | undefined, now: number) =>
  startedAt && Number.isFinite(Date.parse(startedAt)) ? formatElapsed(now - Date.parse(startedAt)) : null;

// The current time, refreshed every second while the component is mounted
// and `active` holds (always when omitted): a page with nothing running
// keeps no timer. Turning active again reads the time at once.
export const useNow = (active: MaybeRefOrGetter<boolean> = true) => {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const sync = (running: boolean) => {
    if (running && !timer) {
      now.value = Date.now();
      timer = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!running) stop();
  };
  let stopWatch: (() => void) | null = null;
  onMounted(() => {
    stopWatch = watch(() => toValue(active), sync, { immediate: true });
  });
  onBeforeUnmount(() => {
    stopWatch?.();
    stop();
  });
  return now;
};

import {useSyncExternalStore} from "react";

/**
 * Playback position lives outside React state. `timeupdate` fires ~4 times a
 * second; keeping the value in App state re-rendered the whole tree on every
 * tick. Only components that call `useCurrentTime` re-render now.
 */
let value = 0;
const listeners = new Set<() => void>();

export const timeStore = {
  get: () => value,
  set(next: number) {
    const safe = Number.isFinite(next) ? next : 0;
    if (safe === value) return;
    value = safe;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useCurrentTime(): number {
  return useSyncExternalStore(timeStore.subscribe, timeStore.get);
}

import {useEffect, useState, type RefObject} from "react";

export type SleepMode = null | {type: "timer"; endsAt: number} | {type: "track"};

export const SLEEP_FADE_MS = 8000;

type Options = {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Volume the element should return to after a fade is cancelled or finished. */
  getVolume: () => number;
  onSleep?: () => void;
};

/**
 * Timed sleep: a single timeout, then a short fade driven by a 100 ms interval
 * that only exists during the final seconds. Nothing runs while the timer is
 * idle, so it costs nothing in the background.
 */
export function useSleepTimer({audioRef, getVolume, onSleep}: Options) {
  const [mode, setMode] = useState<SleepMode>(null);

  useEffect(() => {
    if (mode?.type !== "timer") return;
    const audio = audioRef.current;
    let fade: number | undefined;
    const wait = Math.max(0, mode.endsAt - Date.now() - SLEEP_FADE_MS);
    const start = window.setTimeout(() => {
      const from = audio?.volume ?? 1;
      const began = performance.now();
      fade = window.setInterval(() => {
        const k = Math.min(1, (performance.now() - began) / SLEEP_FADE_MS);
        if (audio) audio.volume = from * (1 - k);
        if (k < 1) return;
        window.clearInterval(fade);
        fade = undefined;
        audio?.pause();
        if (audio) audio.volume = getVolume();
        setMode(null);
        onSleep?.();
      }, 100);
    }, wait);
    return () => {
      window.clearTimeout(start);
      if (fade !== undefined) {
        window.clearInterval(fade);
        if (audio) audio.volume = getVolume();
      }
    };
    // getVolume/onSleep are read through refs by the caller; the timer must
    // only restart when the mode itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return {mode, setMode};
}

export function formatRemaining(endsAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

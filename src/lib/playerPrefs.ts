import type {PlayerPrefs, RepeatMode} from "../types";
import {api} from "../api";

const KEY = "prismatic.playerPrefs";

const defaults: PlayerPrefs = {
  shuffle: false,
  repeat: "off",
  volume: 0.86,
  muted: false,
};

function parseRepeat(value: unknown): RepeatMode {
  if (value === "all" || value === "one" || value === "off") return value;
  return "off";
}

function normalize(raw: Partial<PlayerPrefs> | null | undefined): PlayerPrefs {
  const volume = typeof raw?.volume === "number" && Number.isFinite(raw.volume)
    ? Math.min(1, Math.max(0, raw.volume))
    : defaults.volume;
  return {
    shuffle: Boolean(raw?.shuffle),
    repeat: parseRepeat(raw?.repeat),
    volume,
    muted: Boolean(raw?.muted),
  };
}

/** Browser-only fallback (Railway). Origin-scoped — not shared with desktop. */
export function loadPlayerPrefsLocal(): PlayerPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {...defaults};
    return normalize(JSON.parse(raw) as Partial<PlayerPrefs>);
  } catch {
    return {...defaults};
  }
}

function savePlayerPrefsLocal(prefs: PlayerPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Quota / private mode
  }
}

/**
 * Offline local/desktop: prefs on disk under Music/Prismatic/.prismatic/player.json
 * so local web + Electron share the same offline user data.
 */
export async function loadPlayerPrefs(mode: "local" | "cloud"): Promise<PlayerPrefs> {
  if (mode === "local") {
    try {
      return normalize(await api.playerPrefs());
    } catch {
      // fall through
    }
  }
  return loadPlayerPrefsLocal();
}

export async function savePlayerPrefs(mode: "local" | "cloud", prefs: PlayerPrefs): Promise<void> {
  if (mode === "local") {
    try {
      await api.savePlayerPrefs(prefs);
      savePlayerPrefsLocal(prefs);
      return;
    } catch {
      // fall through
    }
  }
  savePlayerPrefsLocal(prefs);
}

import type {PlayerPrefs, RepeatMode} from "../types";
import {api} from "../api";

const KEY = "prismatic.playerPrefs";

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

/** Clamp to the supported range and snap to 0.05 steps so UI labels stay tidy. */
export function normalizeRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, value)) * 20) / 20;
}

const defaults: PlayerPrefs = {
  schemaVersion: 3,
  shuffle: false,
  repeat: "off",
  volume: 0.86,
  muted: false,
  playbackRate: 1,
  visualizerQuality: "low",
  resumeBehavior: "position",
  libraryMode: "songs",
  librarySort: "title",
  compactPlayer: false,
};

function parseRepeat(value: unknown): RepeatMode {
  if (value === "all" || value === "one" || value === "off") return value;
  return "off";
}

function normalize(raw: Partial<PlayerPrefs> | null | undefined): PlayerPrefs {
  const volume = typeof raw?.volume === "number" && Number.isFinite(raw.volume)
    ? Math.min(1, Math.max(0, raw.volume))
    : defaults.volume;
  // Before schema 3 resumeBehavior had no UI and always held the "track"
  // default, so it carries no user choice: adopt the new default.
  const legacy = !raw?.schemaVersion || raw.schemaVersion < 3;
  return {
    schemaVersion: 3,
    shuffle: Boolean(raw?.shuffle),
    repeat: parseRepeat(raw?.repeat),
    volume,
    muted: Boolean(raw?.muted),
    playbackRate: normalizeRate(raw?.playbackRate),
    visualizerQuality: raw?.visualizerQuality === "high" ? "high" : "low",
    resumeBehavior: legacy ? "position" : raw?.resumeBehavior === "track" ? "track" : "position",
    libraryMode: raw?.libraryMode === "albums" || raw?.libraryMode === "artists" ? raw.libraryMode : "songs",
    librarySort: raw?.librarySort === "artist" || raw?.librarySort === "album" || raw?.librarySort === "bitrate" || raw?.librarySort === "duration"
      ? raw.librarySort
      : "title",
    compactPlayer: Boolean(raw?.compactPlayer),
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

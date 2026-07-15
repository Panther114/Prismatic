import type {PlayerPrefs, RepeatMode} from "../types";

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

export function loadPlayerPrefs(): PlayerPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {...defaults};
    const parsed = JSON.parse(raw) as Partial<PlayerPrefs>;
    const volume = typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
      ? Math.min(1, Math.max(0, parsed.volume))
      : defaults.volume;
    return {
      shuffle: Boolean(parsed.shuffle),
      repeat: parseRepeat(parsed.repeat),
      volume,
      muted: Boolean(parsed.muted),
    };
  } catch {
    return {...defaults};
  }
}

export function savePlayerPrefs(prefs: PlayerPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Quota / private mode
  }
}

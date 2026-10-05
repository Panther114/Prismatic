export type ShortcutAction =
  | "playPause" | "next" | "prev" | "seekBack" | "seekForward" | "seekBackLong" | "seekForwardLong"
  | "volumeUp" | "volumeDown" | "mute" | "shuffle" | "repeat" | "speedDown" | "speedUp"
  | "queue" | "search" | "import" | "help" | "library" | "playlists" | "studio" | "nowPlaying";

export type ShortcutDef = {action: ShortcutAction; keys: string; label: string; group: string};

/** Single source of truth for both the key handler and the cheat-sheet overlay. */
export const SHORTCUTS: ShortcutDef[] = [
  {action: "playPause", keys: "Space", label: "Play / pause", group: "Playback"},
  {action: "next", keys: "N", label: "Next track", group: "Playback"},
  {action: "prev", keys: "P", label: "Previous track", group: "Playback"},
  {action: "seekBack", keys: "←", label: "Back 5 seconds", group: "Playback"},
  {action: "seekForward", keys: "→", label: "Forward 5 seconds", group: "Playback"},
  {action: "seekBackLong", keys: "Shift + ←", label: "Back 30 seconds", group: "Playback"},
  {action: "seekForwardLong", keys: "Shift + →", label: "Forward 30 seconds", group: "Playback"},
  {action: "speedDown", keys: "[", label: "Slower", group: "Playback"},
  {action: "speedUp", keys: "]", label: "Faster", group: "Playback"},
  {action: "volumeUp", keys: "↑", label: "Volume up", group: "Sound"},
  {action: "volumeDown", keys: "↓", label: "Volume down", group: "Sound"},
  {action: "mute", keys: "M", label: "Mute", group: "Sound"},
  {action: "shuffle", keys: "S", label: "Toggle shuffle", group: "Sound"},
  {action: "repeat", keys: "R", label: "Cycle repeat", group: "Sound"},
  {action: "search", keys: "/", label: "Search library", group: "Navigate"},
  {action: "queue", keys: "Q", label: "Show queue", group: "Navigate"},
  {action: "nowPlaying", keys: "Alt + 4", label: "Now playing", group: "Navigate"},
  {action: "library", keys: "Alt + 1", label: "Library", group: "Navigate"},
  {action: "playlists", keys: "Alt + 2", label: "Playlists", group: "Navigate"},
  {action: "studio", keys: "Alt + 3", label: "Studio", group: "Navigate"},
  {action: "import", keys: "Ctrl + O", label: "Import files", group: "Navigate"},
  {action: "help", keys: "?", label: "Keyboard shortcuts", group: "Navigate"},
];

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

/** Maps a key event to an action, or null. Percent-seek digits are handled separately. */
export function resolveShortcut(event: KeyLike): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.altKey && !mod) {
    if (key === "1") return "library";
    if (key === "2") return "playlists";
    if (key === "3") return "studio";
    if (key === "4") return "nowPlaying";
    return null;
  }
  if (mod) {
    if (key === "o") return "import";
    if (key === "f") return "search";
    return null;
  }
  if (event.code === "Space") return "playPause";
  switch (key) {
    case "ArrowLeft": return event.shiftKey ? "seekBackLong" : "seekBack";
    case "ArrowRight": return event.shiftKey ? "seekForwardLong" : "seekForward";
    case "ArrowUp": return "volumeUp";
    case "ArrowDown": return "volumeDown";
    case "n": return "next";
    case "p": return "prev";
    case "m": return "mute";
    case "s": return "shuffle";
    case "r": return "repeat";
    case "q": return "queue";
    case "[": return "speedDown";
    case "]": return "speedUp";
    case "/": return "search";
    case "?": return "help";
    default: return null;
  }
}

/** Digits 0-9 jump to 0%-90% of the track, like most media players. */
export function digitSeekRatio(event: KeyLike): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  return /^[0-9]$/.test(event.key) ? Number(event.key) / 10 : null;
}

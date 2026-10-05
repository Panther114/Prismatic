const KEY = "prismatic.recent.v1";
const LIMIT = 100;

/** Most-recent-first list with the new id moved to the front and the tail capped. */
export function pushRecent(list: string[], trackId: string, limit = LIMIT): string[] {
  return [trackId, ...list.filter((id) => id !== trackId)].slice(0, limit);
}

export function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch {
    // Convenience only.
  }
}

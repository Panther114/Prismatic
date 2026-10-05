import type {Playlist} from "../types";

/**
 * Favorites is an ordinary playlist with a reserved name. That keeps it in the
 * sidebar, in zip exports and in full-library backups without a second store.
 */
export const FAVORITES_NAME = "Favorites";

export function findFavorites(playlists: Playlist[]): Playlist | undefined {
  return playlists.find((playlist) => playlist.name === FAVORITES_NAME);
}

export function favoriteIdSet(playlists: Playlist[]): Set<string> {
  return new Set(findFavorites(playlists)?.trackIds ?? []);
}

/** Toggle membership; new favorites go to the top so the latest heart is first. */
export function toggleFavoriteIds(ids: string[], trackId: string): string[] {
  return ids.includes(trackId) ? ids.filter((id) => id !== trackId) : [trackId, ...ids];
}

import type {Track} from "../types";

/** True when the cover is a real embedded/art image, not the default note placeholder. */
export function isRealCover(url: string | undefined | null): boolean {
  if (!url) return false;
  if (url.includes("music-note")) return false;
  if (url === "/music-note.png") return false;
  return true;
}

/**
 * Grid size for playlist mosaic: only 1×1, 2×2, or 3×3.
 * n = count of tracks with a real cover.
 */
export function mosaicGridSize(realCoverCount: number): 1 | 2 | 3 {
  if (realCoverCount <= 1) return 1;
  if (realCoverCount <= 4) return 2;
  return 3;
}

export function playlistCoverUrls(trackIds: string[], tracksById: Map<string, Track>): string[] {
  const urls: string[] = [];
  for (const id of trackIds) {
    const track = tracksById.get(id);
    if (track && isRealCover(track.coverUrl)) urls.push(track.coverUrl);
  }
  return urls;
}

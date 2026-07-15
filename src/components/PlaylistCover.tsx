import {useMemo} from "react";
import type {Track} from "../types";
import {mosaicGridSize, playlistCoverUrls} from "../lib/coverUtils";

type Props = {
  trackIds: string[];
  tracksById: Map<string, Track>;
  size?: number;
  className?: string;
};

/**
 * Playlist mosaic: 1 cell, 2×2, or 3×3 from real cover arts only.
 * Empty cells when n doesn't fill the grid (e.g. 3 arts → 2×2 with one blank).
 */
export function PlaylistCover({trackIds, tracksById, size = 40, className = ""}: Props) {
  const urls = useMemo(() => playlistCoverUrls(trackIds, tracksById), [trackIds, tracksById]);
  const grid = mosaicGridSize(urls.length);
  const cells = grid * grid;
  const tiles = Array.from({length: cells}, (_, i) => urls[i] || null);

  if (grid === 1) {
    const src = tiles[0];
    return (
      <span className={`playlist-cover ${className}`} style={{width: size, height: size}} aria-hidden="true">
        {src
          ? <img src={src} alt="" />
          : <img className="fallback-note" src="/music-note.png" alt="" />}
      </span>
    );
  }

  return (
    <span
      className={`playlist-cover mosaic mosaic-${grid} ${className}`}
      style={{width: size, height: size, gridTemplateColumns: `repeat(${grid}, 1fr)`, gridTemplateRows: `repeat(${grid}, 1fr)`}}
      aria-hidden="true"
    >
      {tiles.map((src, i) => (
        <span key={i} className={`playlist-cover-cell ${src ? "" : "empty"}`}>
          {src ? <img src={src} alt="" /> : null}
        </span>
      ))}
    </span>
  );
}

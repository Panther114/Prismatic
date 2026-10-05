import {useMemo} from "react";
import {CoverImage} from "./CoverImage";
import type {Track} from "../types";
import {mosaicGridSize, playlistCoverUrls} from "../lib/coverUtils";

type Props = {
  trackIds: string[];
  tracksById: Map<string, Track>;
  size?: number;
  className?: string;
  /** Colours the placeholder when no track has artwork; defaults to the first track id. */
  seed?: string;
};

/**
 * Playlist mosaic: 1 cell, 2×2, or 3×3 from real cover arts only.
 * Empty cells when n doesn't fill the grid (e.g. 3 arts → 2×2 with one blank).
 */
export function PlaylistCover({trackIds, tracksById, size = 40, className = "", seed: seedProp}: Props) {
  const seed = seedProp ?? trackIds[0] ?? "playlist";
  const urls = useMemo(() => playlistCoverUrls(trackIds, tracksById), [trackIds, tracksById]);
  const grid = mosaicGridSize(urls.length);
  const cells = grid * grid;
  const tiles = Array.from({length: cells}, (_, i) => urls[i] || null);

  if (grid === 1) {
    const src = tiles[0];
    return (
      <span className={`playlist-cover ${className}`} style={{width: size, height: size}} aria-hidden="true">
        <CoverImage src={src} seed={seed} />
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
          {src ? <CoverImage src={src} seed={`${seed}-${i}`} /> : null}
        </span>
      ))}
    </span>
  );
}

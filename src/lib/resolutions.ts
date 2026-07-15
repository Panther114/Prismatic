import type {ResolutionPreset, RenderSettings} from "../types";

export const RESOLUTIONS: Record<ResolutionPreset, {width: number; height: number}> = {
  "720p": {width: 1280, height: 720},
  "1080p": {width: 1920, height: 1080},
  "4k": {width: 3840, height: 2160},
  square: {width: 1080, height: 1080},
  portrait: {width: 1080, height: 1920},
};

export function buildRenderSettings(
  resolution: ResolutionPreset,
  audioBitrate: RenderSettings["audioBitrate"],
): RenderSettings {
  return {
    resolution,
    ...RESOLUTIONS[resolution],
    audioBitrate,
  };
}

/** "Under tale" → "Under_tale_Visuals.webm" */
export function visualsFileName(title: string) {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "Track";
  return `${base}_Visuals.webm`;
}

/** Playlist name → single merged export filename */
export function playlistVisualsFileName(playlistName: string) {
  const base = playlistName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "Playlist";
  return `${base}_Playlist_Visuals.webm`;
}

import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {open, save} from "@tauri-apps/plugin-dialog";
import {isTauri} from "../api";
import type {Playlist, Track} from "../types";
import {playlistStore} from "./playlists";

function safeZipFileName(name: string) {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").trim() || "playlist";
  return cleaned.toLowerCase().endsWith(".zip") ? cleaned : `${cleaned}.zip`;
}

export async function exportPlaylistZip(
  playlist: Playlist,
  allTracks: Track[],
  onProgress?: (message: string, ratio: number) => void,
): Promise<{path: string}> {
  const ids = playlist.trackIds.filter((id) => allTracks.some((t) => t.id === id));
  if (!ids.length) throw new Error("This playlist has no available tracks.");

  if (!isTauri) {
    throw new Error("Export playlist as zip is available in the desktop app.");
  }

  const dest = await save({
    defaultPath: safeZipFileName(playlist.name),
    filters: [{name: "Zip archive", extensions: ["zip"]}],
  });
  if (!dest) throw new Error("Export cancelled.");

  onProgress?.("Starting zip…", 0.02);
  const unlisten = await listen<{message?: string; progress?: number}>("zip-progress", (event) => {
    const message = event.payload?.message;
    const progress = typeof event.payload?.progress === "number" ? event.payload.progress : 0.4;
    if (message) onProgress?.(message, progress);
  });
  try {
    const path = await invoke<string>("export_playlist_zip", {
      trackIds: ids,
      destPath: String(dest),
    });
    onProgress?.("Done", 1);
    return {path};
  } finally {
    unlisten();
  }
}

export async function importPlaylistZip(options: {
  onProgress?: (message: string, ratio: number) => void;
  refreshTracks: () => Promise<Track[]>;
}): Promise<{playlist: Playlist; imported: number; skipped: number; path: string}> {
  if (!isTauri) {
    throw new Error("Import playlist zip is available in the desktop app.");
  }

  const selected = await open({
    multiple: false,
    filters: [{name: "Zip archive", extensions: ["zip"]}],
  });
  if (!selected) throw new Error("Import cancelled.");
  const zipPath = String(selected);

  options.onProgress?.("Reading zip…", 0.05);
  const unlisten = await listen<{message?: string; progress?: number}>("zip-progress", (event) => {
    const message = event.payload?.message;
    const progress = typeof event.payload?.progress === "number" ? event.payload.progress : 0.4;
    if (message) options.onProgress?.(message, progress);
  });
  try {
    const result = await invoke<{
      name: string;
      trackIds: string[];
      imported: number;
      skipped: number;
    }>("import_playlist_zip", {zipPath});
    options.onProgress?.("Forging playlist…", 0.95);
    await options.refreshTracks();
    if (!result.trackIds?.length) {
      throw new Error("No supported audio files found in the zip.");
    }
    const playlist = await playlistStore.create(result.name || "Imported playlist", result.trackIds);
    options.onProgress?.("Done", 1);
    return {
      playlist,
      imported: result.imported ?? 0,
      skipped: result.skipped ?? 0,
      path: zipPath,
    };
  } finally {
    unlisten();
  }
}

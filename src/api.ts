import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-dialog";
import {openPath} from "@tauri-apps/plugin-opener";
import type {Playlist, PlayerPrefs, RenderSettings, Track, WatchFolder} from "./types";

export type HealthInfo = {
  ok: boolean;
  name?: string;
  mode: "local" | "cloud";
  clientExport: boolean;
  port?: number;
  desktop?: boolean;
  version?: string | null;
  distOk?: boolean;
  distMarker?: string;
  appRoot?: string;
};

export type LibraryMeta = {
  generation: number;
  watchFolders: WatchFolder[];
  musicDirectory: string;
  dataRoot?: string;
  offlineRoot?: string;
  mode?: "local" | "cloud";
  clientExport?: boolean;
  sharedLibrary?: boolean;
  offlineOnly?: boolean;
};

export type PlayerPrefsDto = PlayerPrefs;

export type LibraryClearResult = {
  tracks: Track[];
  playlists: Playlist[];
  watchFolders: WatchFolder[];
  deletedManagedFiles: number;
  preservedExternalFiles: number;
  failedManagedFiles: string[];
};

export interface PlatformBackend {
  readonly kind: "web" | "tauri";
  health(): Promise<HealthInfo>;
  tracks(): Promise<Track[]>;
  libraryMeta(): Promise<LibraryMeta>;
  updateTrack(id: string, update: {title: string; artist: string}): Promise<Track>;
  removeTrack(id: string, options?: {deleteFile?: boolean}): Promise<Track[]>;
  clearLibrary(): Promise<LibraryClearResult>;
  importAudio(files?: FileList | File[]): Promise<{tracks: Track[]; imported: string[]; skipped: number} | Track[]>;
  importFolder(folderPath: string, maxDepth?: number): Promise<{tracks: Track[]; imported: string[]; skipped: number; musicDirectory: string}>;
  watchFolders(): Promise<WatchFolder[]>;
  addWatchFolder(folderPath: string): Promise<WatchFolder[]>;
  removeWatchFolder(id: string): Promise<WatchFolder[]>;
  browseWatchFolder(): Promise<{path: string | null; cancelled?: boolean}>;
  startRender(trackId: string, settings: Pick<RenderSettings, "resolution" | "audioBitrate">): Promise<unknown>;
  openOutput(): Promise<unknown>;
  playerPrefs(): Promise<PlayerPrefsDto>;
  savePlayerPrefs(prefs: PlayerPrefsDto): Promise<PlayerPrefsDto>;
  playlists(): Promise<Playlist[]>;
  createPlaylist(body: {name: string; trackIds?: string[]}): Promise<Playlist>;
  updatePlaylist(id: string, body: {name?: string; trackIds?: string[]}): Promise<Playlist>;
  deletePlaylist(id: string): Promise<Playlist[]>;
  waveform(id: string): Promise<number[]>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      const snippet = text.replace(/\s+/g, " ").slice(0, 140);
      throw new Error(
        response.ok
          ? `Invalid JSON from ${url}: ${snippet}`
          : `Request failed (${response.status}) for ${url}: ${snippet}`,
      );
    }
  }
  if (!response.ok) {
    const error = (body as {error?: string} | null)?.error;
    throw new Error(error || `Request failed (${response.status})`);
  }
  return body as T;
}

class WebBackend implements PlatformBackend {
  readonly kind = "web" as const;
  health = () => json<HealthInfo>("/api/health");
  tracks = () => json<Track[]>("/api/tracks");
  libraryMeta = () => json<LibraryMeta>("/api/library/meta");
  updateTrack = (id: string, update: {title: string; artist: string}) => json<Track>(`/api/tracks/${id}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(update),
  });
  removeTrack = (id: string, options: {deleteFile?: boolean} = {}) =>
    json<Track[]>(`/api/tracks/${encodeURIComponent(id)}?deleteFile=${options.deleteFile ? "1" : "0"}`, {method: "DELETE"});
  clearLibrary = () => json<LibraryClearResult>("/api/library", {method: "DELETE"});
  importAudio = (files: FileList | File[] = []) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("audio", file));
    return json<{tracks: Track[]; imported: string[]; skipped: number} | Track[]>("/api/import", {method: "POST", body: form});
  };
  importFolder = (folderPath: string, maxDepth = 0) =>
    json<{tracks: Track[]; imported: string[]; skipped: number; musicDirectory: string}>("/api/import-folder", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({path: folderPath, maxDepth}),
    });
  watchFolders = () => json<WatchFolder[]>("/api/watch-folders");
  addWatchFolder = (folderPath: string) => json<WatchFolder[]>("/api/watch-folders", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({path: folderPath}),
  });
  removeWatchFolder = (id: string) => json<WatchFolder[]>(`/api/watch-folders/${encodeURIComponent(id)}`, {method: "DELETE"});
  browseWatchFolder = () => json<{path: string | null; cancelled?: boolean}>("/api/watch-folders/browse", {method: "POST"});
  startRender = (trackId: string, settings: Pick<RenderSettings, "resolution" | "audioBitrate">) => json("/api/render", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({trackId, ...settings}),
  });
  openOutput = () => fetch("/api/open-output", {method: "POST"});
  playerPrefs = () => json<PlayerPrefsDto>("/api/player-prefs");
  savePlayerPrefs = (prefs: PlayerPrefsDto) => json<PlayerPrefsDto>("/api/player-prefs", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(prefs),
  });
  playlists = () => json<Playlist[]>("/api/playlists");
  createPlaylist = (body: {name: string; trackIds?: string[]}) => json<Playlist>("/api/playlists", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  updatePlaylist = (id: string, body: {name?: string; trackIds?: string[]}) => json<Playlist>(`/api/playlists/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  deletePlaylist = (id: string) => json<Playlist[]>(`/api/playlists/${encodeURIComponent(id)}`, {method: "DELETE"});
  async waveform(id: string) {
    const response = await fetch(`/api/tracks/${encodeURIComponent(id)}/waveform`);
    if (!response.ok) return [];
    return response.json() as Promise<number[]>;
  }
}

type DesktopTrack = Omit<Track, "mediaUrl" | "coverUrl"> & {
  mediaPath: string;
  coverPath?: string | null;
};

const audioFilters = [{
  name: "Audio",
  extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"],
}];

function mapDesktopTrack(track: DesktopTrack): Track {
  return {
    ...track,
    mediaUrl: convertFileSrc(track.mediaPath),
    coverUrl: track.coverPath ? convertFileSrc(track.coverPath) : "/music-note.svg",
  };
}

class TauriBackend implements PlatformBackend {
  readonly kind = "tauri" as const;
  health = () => invoke<HealthInfo>("health");
  async tracks() {
    return (await invoke<DesktopTrack[]>("tracks")).map(mapDesktopTrack);
  }
  libraryMeta = () => invoke<LibraryMeta>("library_meta");
  async updateTrack(id: string, update: {title: string; artist: string}) {
    return mapDesktopTrack(await invoke<DesktopTrack>("update_track", {id, ...update}));
  }
  async removeTrack(id: string, options: {deleteFile?: boolean} = {}) {
    return (await invoke<DesktopTrack[]>("remove_track", {id, deleteFile: Boolean(options.deleteFile)})).map(mapDesktopTrack);
  }
  async clearLibrary() {
    const result = await invoke<Omit<LibraryClearResult, "tracks"> & {tracks: DesktopTrack[]}>("clear_library");
    return {...result, tracks: result.tracks.map(mapDesktopTrack)};
  }
  async importAudio() {
    const selection = await open({multiple: true, directory: false, filters: audioFilters});
    if (!selection) return {tracks: await this.tracks(), imported: [], skipped: 0};
    const files = Array.isArray(selection) ? selection : [selection];
    const tracks = (await invoke<DesktopTrack[]>("import_paths", {files})).map(mapDesktopTrack);
    return {tracks, imported: files, skipped: 0};
  }
  async importFolder(folderPath: string, maxDepth = 0) {
    const tracks = (await invoke<DesktopTrack[]>("import_folder", {folderPath, maxDepth})).map(mapDesktopTrack);
    const meta = await this.libraryMeta();
    return {tracks, imported: [], skipped: 0, musicDirectory: meta.musicDirectory};
  }
  async watchFolders() {
    return (await this.libraryMeta()).watchFolders;
  }
  addWatchFolder = (folderPath: string) => invoke<WatchFolder[]>("add_watch_folder", {folderPath});
  removeWatchFolder = (id: string) => invoke<WatchFolder[]>("remove_watch_folder", {id});
  async browseWatchFolder() {
    const selection = await open({multiple: false, directory: true});
    return selection ? {path: String(selection)} : {path: null, cancelled: true};
  }
  startRender = async () => ({clientExport: true});
  async openOutput() {
    return openPath(await invoke<string>("output_directory"));
  }
  playerPrefs = () => invoke<PlayerPrefsDto>("player_prefs");
  savePlayerPrefs = (prefs: PlayerPrefsDto) => invoke<PlayerPrefsDto>("save_player_prefs", {prefs});
  playlists = () => invoke<Playlist[]>("playlists");
  createPlaylist = (body: {name: string; trackIds?: string[]}) =>
    invoke<Playlist>("create_playlist", {name: body.name, trackIds: body.trackIds || []});
  updatePlaylist = (id: string, body: {name?: string; trackIds?: string[]}) =>
    invoke<Playlist>("update_playlist", {id, name: body.name, trackIds: body.trackIds});
  deletePlaylist = (id: string) => invoke<Playlist[]>("delete_playlist", {id});
  waveform = (id: string) => invoke<number[]>("waveform", {id});
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const api: PlatformBackend = isTauri ? new TauriBackend() : new WebBackend();

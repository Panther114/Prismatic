import type {RenderSettings, Track, WatchFolder} from "./types";

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

export type HealthInfo = {
  ok: boolean;
  name?: string;
  mode: "local" | "cloud";
  clientExport: boolean;
  port?: number;
};

export type LibraryMeta = {
  generation: number;
  watchFolders: WatchFolder[];
  musicDirectory: string;
  mode?: "local" | "cloud";
  clientExport?: boolean;
};

export const api = {
  health: () => json<HealthInfo>("/api/health"),
  tracks: () => json<Track[]>("/api/tracks"),
  libraryMeta: () => json<LibraryMeta>("/api/library/meta"),
  updateTrack: (id: string, update: {title: string; artist: string}) => json<Track>(`/api/tracks/${id}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(update),
  }),
  removeTrack: (id: string, options: {deleteFile?: boolean} = {}) =>
    json<Track[]>(
      `/api/tracks/${encodeURIComponent(id)}?deleteFile=${options.deleteFile ? "1" : "0"}`,
      {method: "DELETE"},
    ),
  importAudio: (files: FileList | File[]) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("audio", file));
    return json<Track[]>("/api/import", {method: "POST", body: form});
  },
  watchFolders: () => json<WatchFolder[]>("/api/watch-folders"),
  addWatchFolder: (folderPath: string) => json<WatchFolder[]>("/api/watch-folders", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({path: folderPath}),
  }),
  removeWatchFolder: (id: string) => json<WatchFolder[]>(`/api/watch-folders/${encodeURIComponent(id)}`, {method: "DELETE"}),
  browseWatchFolder: () => json<{path: string | null; cancelled?: boolean}>("/api/watch-folders/browse", {method: "POST"}),
  /** @deprecated Server render is disabled — use client export. */
  startRender: (trackId: string, settings: Pick<RenderSettings, "resolution" | "audioBitrate">) => json(`/api/render`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({trackId, ...settings}),
  }),
  openOutput: () => fetch("/api/open-output", {method: "POST"}),
};

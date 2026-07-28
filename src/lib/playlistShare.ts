import type {Playlist, Track} from "../types";
import {api, isTauri} from "../api";
import {clientLibrary} from "./clientLibrary";
import {idbGetTrackAudio} from "./clientIdb";
import {playlistStore} from "./playlists";

const EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
};

function mimeForFileName(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return EXT_MIME[ext] || "application/octet-stream";
}

export const SHARE_MAX_TRACKS = 25;
export const SHARE_MAX_DURATION_SEC = 100 * 60;

export type ShareCreateResult = {
  code: string;
  expiresAt: string;
  trackCount: number;
  totalDuration: number;
  name: string;
};

export type ShareManifest = {
  code: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  trackCount: number;
  totalDuration: number;
  totalBytes: number;
  tracks: Array<{
    index: number;
    fileName: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    bitrate: number | null;
    format: string;
    size: number;
    contentType: string;
  }>;
};

export function validateShareLimits(tracks: Track[]): {ok: true} | {ok: false; error: string} {
  if (!tracks.length) return {ok: false, error: "Playlist is empty."};
  if (tracks.length > SHARE_MAX_TRACKS) {
    return {ok: false, error: `Shared playlists are limited to ${SHARE_MAX_TRACKS} tracks.`};
  }
  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  if (total >= SHARE_MAX_DURATION_SEC) {
    return {ok: false, error: "Shared playlists must be under 100 minutes total."};
  }
  return {ok: true};
}

async function blobForTrack(track: Track): Promise<{blob: Blob; fileName: string; contentType: string}> {
  if (track.clientOnly) {
    const stored = await idbGetTrackAudio(track.id);
    if (stored?.audio) {
      const type = stored.audioType || "audio/mpeg";
      return {
        blob: new Blob([stored.audio], {type}),
        fileName: stored.fileName || track.fileName,
        contentType: type,
      };
    }
    const materialized = await clientLibrary.materialize(track.id);
    const extras = clientLibrary.getExtras(track.id);
    if (extras?.file) {
      return {
        blob: extras.file,
        fileName: extras.file.name || track.fileName,
        contentType: extras.file.type || "audio/mpeg",
      };
    }
    if (materialized?.mediaUrl && !materialized.mediaUrl.startsWith("client-audio:")) {
      const response = await fetch(materialized.mediaUrl);
      if (!response.ok) throw new Error(`Could not read “${track.title}”.`);
      const blob = await response.blob();
      return {blob, fileName: track.fileName, contentType: blob.type || "audio/mpeg"};
    }
    throw new Error(`Could not read “${track.title}” from browser storage.`);
  }

  // Desktop: read via Rust (CSP blocks fetch of asset:// / asset.localhost → "Failed to fetch").
  if (isTauri) {
    try {
      const {invoke} = await import("@tauri-apps/api/core");
      const raw = await invoke<number[] | Uint8Array>("read_track_bytes", {id: track.id});
      const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      const contentType = mimeForFileName(track.fileName);
      return {
        blob: new Blob([u8], {type: contentType}),
        fileName: track.fileName,
        contentType,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not read “${track.title}”: ${message}`);
    }
  }

  const response = await fetch(track.mediaUrl);
  if (!response.ok) throw new Error(`Could not read “${track.title}”.`);
  const blob = await response.blob();
  return {
    blob,
    fileName: track.fileName,
    contentType: blob.type || mimeForFileName(track.fileName),
  };
}

export async function createPlaylistShare(
  playlist: Playlist,
  allTracks: Track[],
  onProgress?: (message: string, ratio: number) => void,
): Promise<ShareCreateResult> {
  const tracks = playlist.trackIds
    .map((id) => allTracks.find((t) => t.id === id))
    .filter((t): t is Track => Boolean(t));
  const limits = validateShareLimits(tracks);
  if (!limits.ok) throw new Error(limits.error);

  // Desktop: native HTTP + disk reads (WebView fetch to Railway is unreliable / CSP-blocked).
  if (isTauri) {
    onProgress?.("Waking share server & packing tracks…", 0.05);
    const {invoke} = await import("@tauri-apps/api/core");
    const {getConfiguredShareBase} = await import("./shareHost");
    onProgress?.("Uploading to share server…", 0.35);
    const result = await invoke<{
      code: string;
      expiresAt: string;
      trackCount: number;
      totalDuration: number;
      name: string;
    }>("share_create_playlist", {
      baseUrl: getConfiguredShareBase(),
      name: playlist.name,
      trackIds: tracks.map((t) => t.id),
    });
    onProgress?.("Done", 1);
    if (!result?.code || String(result.code).length !== 4) {
      throw new Error("Share host returned an invalid code.");
    }
    return {
      code: result.code,
      expiresAt: result.expiresAt,
      trackCount: result.trackCount,
      totalDuration: result.totalDuration,
      name: result.name,
    };
  }

  const form = new FormData();
  form.append("name", playlist.name);
  const meta: Array<{
    fileName: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    bitrate: number | null;
    format: string;
    contentType: string;
  }> = [];

  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    onProgress?.(`Packing ${i + 1}/${tracks.length}: ${track.title}`, i / (tracks.length + 1));
    const {blob, fileName, contentType} = await blobForTrack(track);
    meta.push({
      fileName,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      bitrate: track.bitrate,
      format: track.format,
      contentType,
    });
    form.append("audio", blob, fileName);
  }
  form.append("tracks", JSON.stringify(meta));
  onProgress?.("Uploading share package…", tracks.length / (tracks.length + 1));
  return api.createPlaylistShare(form, (message) => onProgress?.(message, tracks.length / (tracks.length + 1)));
}

export async function redeemPlaylistShare(
  code: string,
  options: {
    cloudMode: boolean;
    onProgress?: (message: string, ratio: number) => void;
    refreshTracks: () => Promise<Track[]>;
  },
): Promise<{playlist: Playlist; imported: number; skipped: number}> {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 4);
  if (normalized.length !== 4) throw new Error("Enter a 4-digit share code.");

  options.onProgress?.("Looking up share…", 0.02);

  type Manifest = Awaited<ReturnType<typeof api.getPlaylistShare>>;
  let manifest: Manifest;

  if (isTauri) {
    const {invoke} = await import("@tauri-apps/api/core");
    const {getConfiguredShareBase} = await import("./shareHost");
    options.onProgress?.("Waking share server…", 0.04);
    manifest = await invoke<Manifest>("share_get_manifest", {
      baseUrl: getConfiguredShareBase(),
      code: normalized,
    });
  } else {
    manifest = await api.getPlaylistShare(normalized, (message) => options.onProgress?.(message, 0.04));
  }

  const limits = validateShareLimits(
    manifest.tracks.map((t) => ({
      id: String(t.index),
      sourceId: "share",
      fileName: t.fileName,
      relativePath: t.fileName,
      folder: "Share",
      mediaUrl: "",
      coverUrl: "",
      waveformUrl: "",
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
      bitrate: t.bitrate,
      format: t.format,
    })),
  );
  if (!limits.ok) throw new Error(limits.error);

  const files: File[] = [];
  for (let i = 0; i < manifest.tracks.length; i += 1) {
    const meta = manifest.tracks[i];
    options.onProgress?.(
      `Downloading ${i + 1}/${manifest.tracks.length}: ${meta.title}`,
      0.05 + (i / manifest.tracks.length) * 0.7,
    );
    let blob: Blob;
    if (isTauri) {
      const {invoke} = await import("@tauri-apps/api/core");
      const {getConfiguredShareBase} = await import("./shareHost");
      const raw = await invoke<number[] | Uint8Array>("share_download_track", {
        baseUrl: getConfiguredShareBase(),
        code: normalized,
        index: meta.index,
      });
      const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      blob = new Blob([u8], {type: meta.contentType || "audio/mpeg"});
    } else {
      blob = await api.downloadPlaylistShareTrack(
        normalized,
        meta.index,
        (message) => options.onProgress?.(message, 0.05 + (i / manifest.tracks.length) * 0.7),
      );
    }
    const type = meta.contentType || blob.type || "audio/mpeg";
    files.push(new File([blob], meta.fileName, {type}));
  }

  options.onProgress?.("Importing into library…", 0.8);
  let imported = 0;
  let skipped = 0;
  const before = await options.refreshTracks();
  const beforeIds = new Set(before.map((t) => t.id));
  const beforeByName = new Map(before.map((t) => [t.fileName, t]));

  if (options.cloudMode) {
    const result = await clientLibrary.importFiles(files);
    imported = result.imported.length;
    skipped = result.skipped;
  } else if (isTauri && api.importAudioBytes) {
    const payloads = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const result = await api.importAudioBytes(payloads);
    imported = result.imported;
    skipped = result.skipped;
  } else {
    const result = await api.importAudio(files);
    if (Array.isArray(result)) {
      imported = Math.max(0, result.length - before.length);
    } else {
      imported = result.imported?.length ?? 0;
      skipped = result.skipped ?? 0;
    }
  }

  options.onProgress?.("Forging playlist…", 0.92);
  const after = await options.refreshTracks();
  const newByFile = new Map(after.map((t) => [t.fileName, t]));

  const forgedIds: string[] = [];
  for (const meta of manifest.tracks) {
    const match =
      newByFile.get(meta.fileName)
      || after.find((t) => t.title === meta.title && t.artist === meta.artist && !beforeIds.has(t.id))
      || beforeByName.get(meta.fileName);
    if (match && !forgedIds.includes(match.id)) forgedIds.push(match.id);
  }

  if (!forgedIds.length) {
    throw new Error("Tracks downloaded but none could be matched into the library.");
  }

  const playlist = await playlistStore.create(manifest.name, forgedIds);
  options.onProgress?.("Done", 1);
  return {playlist, imported, skipped};
}

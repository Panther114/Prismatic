/**
 * Temporary playlist share packages (4-digit codes, 24h TTL).
 * Disk-backed only. Uploads are per-track so each request stays under Railway's
 * 5-minute request-body limit.
 */
import {promises as fs, createReadStream, existsSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomInt} from "node:crypto";

export const SHARE_MAX_TRACKS = 25;
export const SHARE_MAX_DURATION_SEC = 100 * 60;
export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const SHARE_MAX_PACKAGE_BYTES = 700 * 1024 * 1024;
export const SHARE_MAX_TRACK_BYTES = 120 * 1024 * 1024;
export const SHARE_MAX_ACTIVE = 40;
/** Concurrent single-track uploads (not whole-playlist posts). */
export const SHARE_MAX_CONCURRENT_UPLOADS = 4;

export type ShareTrackMeta = {
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
};

export type ShareManifest = {
  code: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  trackCount: number;
  totalDuration: number;
  totalBytes: number;
  tracks: ShareTrackMeta[];
  /** false while tracks are still uploading; redeem only when true. */
  complete: boolean;
};

export type ShareTrackMetaInput = {
  fileName: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  bitrate: number | null;
  format: string;
  contentType: string;
};

type IndexEntry = {
  code: string;
  dir: string;
  expiresAt: number;
  totalBytes: number;
};

function nowIso() {
  return new Date().toISOString();
}

function safeFileName(name: string, fallback: string) {
  const base = path.basename(name || fallback).replace(/[^\p{L}\p{N}._ -]+/gu, "-") || fallback;
  return base.slice(0, 180);
}

async function moveFile(src: string, dest: string) {
  try {
    await fs.rename(src, dest);
  } catch {
    await fs.copyFile(src, dest);
    await fs.unlink(src).catch(() => undefined);
  }
}

function storedTrackName(index: number, fileName: string) {
  return `track-${String(index).padStart(2, "0")}${path.extname(fileName) || ".mp3"}`;
}

export class PlaylistShareStore {
  private root: string;
  private index = new Map<string, IndexEntry>();
  private ready: Promise<void>;

  constructor(rootDirectory?: string) {
    this.root = rootDirectory || path.join(os.tmpdir(), "prismatic-playlist-shares");
    this.ready = this.bootstrap();
  }

  private async bootstrap() {
    await fs.mkdir(this.root, {recursive: true});
    try {
      const entries = await fs.readdir(this.root, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const code = entry.name;
        if (!/^\d{4}$/.test(code)) continue;
        const dir = path.join(this.root, code);
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as ShareManifest;
          const expiresAt = Date.parse(raw.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            await fs.rm(dir, {recursive: true, force: true});
            continue;
          }
          this.index.set(code, {
            code,
            dir,
            expiresAt,
            totalBytes: raw.totalBytes || 0,
          });
        } catch {
          await fs.rm(dir, {recursive: true, force: true}).catch(() => undefined);
        }
      }
    } catch {
      // empty root is fine
    }
  }

  private async ensureReady() {
    await this.ready;
  }

  private async writeManifest(dir: string, manifest: ShareManifest) {
    await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private async readManifest(code: string): Promise<{entry: IndexEntry; manifest: ShareManifest} | null> {
    await this.ensureReady();
    const normalized = String(code || "").trim();
    if (!/^\d{4}$/.test(normalized)) return null;
    const entry = this.index.get(normalized);
    if (!entry) return null;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(entry.dir, "manifest.json"), "utf8")) as ShareManifest;
      if (raw.complete === undefined) raw.complete = true; // legacy packages
      return {entry, manifest: raw};
    } catch {
      this.index.delete(normalized);
      return null;
    }
  }

  async purgeExpired() {
    await this.ensureReady();
    const now = Date.now();
    for (const [code, entry] of [...this.index.entries()]) {
      if (entry.expiresAt > now) continue;
      this.index.delete(code);
      await fs.rm(entry.dir, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const code = String(randomInt(0, 10000)).padStart(4, "0");
      if (!this.index.has(code) && !existsSync(path.join(this.root, code))) return code;
    }
    throw new Error("Could not allocate a free share code. Try again shortly.");
  }

  validateLimits(tracks: Array<{duration: number; size?: number}>) {
    if (!tracks.length) throw new Error("Playlist is empty.");
    if (tracks.length > SHARE_MAX_TRACKS) {
      throw new Error(`Shared playlists are limited to ${SHARE_MAX_TRACKS} tracks.`);
    }
    const totalDuration = tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    if (totalDuration >= SHARE_MAX_DURATION_SEC) {
      throw new Error("Shared playlists must be under 100 minutes total.");
    }
    const totalBytes = tracks.reduce((sum, t) => sum + (Number(t.size) || 0), 0);
    if (totalBytes > SHARE_MAX_PACKAGE_BYTES) {
      throw new Error("Shared playlist package is too large (max ~700 MB).");
    }
    return {totalDuration, totalBytes};
  }

  /** Create a draft share session (metadata only). Client uploads tracks one-by-one. */
  async beginSession(input: {name: string; tracks: ShareTrackMetaInput[]}): Promise<ShareManifest> {
    await this.ensureReady();
    await this.purgeExpired();
    if (this.index.size >= SHARE_MAX_ACTIVE) {
      throw new Error("Share capacity reached on this host. Try again later.");
    }
    const {totalDuration} = this.validateLimits(input.tracks.map((t) => ({duration: t.duration, size: 0})));
    const code = this.allocateCode();
    const dir = path.join(this.root, code);
    await fs.mkdir(dir, {recursive: true});
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS).toISOString();
    const tracks: ShareTrackMeta[] = input.tracks.map((track, index) => {
      const fileName = safeFileName(track.fileName, `track-${index + 1}.mp3`);
      return {
        index,
        fileName,
        title: (track.title || fileName).trim() || fileName,
        artist: (track.artist || "Unknown artist").trim() || "Unknown artist",
        album: (track.album || "").trim(),
        duration: Number(track.duration) || 0,
        bitrate: track.bitrate == null ? null : Math.round(Number(track.bitrate)),
        format: (track.format || path.extname(fileName).slice(1) || "audio").toUpperCase(),
        size: 0,
        contentType: track.contentType || "application/octet-stream",
      };
    });
    const manifest: ShareManifest = {
      code,
      name: (input.name || "Shared playlist").trim() || "Shared playlist",
      createdAt,
      expiresAt,
      trackCount: tracks.length,
      totalDuration,
      totalBytes: 0,
      tracks,
      complete: false,
    };
    await this.writeManifest(dir, manifest);
    this.index.set(code, {code, dir, expiresAt: Date.parse(expiresAt), totalBytes: 0});
    return manifest;
  }

  /** Attach one track file (from multer temp path) to a draft session. */
  async putTrack(code: string, index: number, tempPath: string, patch?: Partial<ShareTrackMetaInput>): Promise<ShareManifest> {
    const loaded = await this.readManifest(code);
    if (!loaded) throw new Error("Share session not found or expired.");
    const {entry, manifest} = loaded;
    if (manifest.complete) throw new Error("Share is already finalized.");
    const meta = manifest.tracks.find((t) => t.index === index);
    if (!meta) throw new Error(`Invalid track index ${index}.`);

    const stat = await fs.stat(tempPath).catch(() => null);
    if (!stat?.isFile() || !stat.size) throw new Error("Track file was empty or missing.");
    if (stat.size > SHARE_MAX_TRACK_BYTES) {
      throw new Error(`Track “${meta.title}” exceeds the per-file size limit.`);
    }

    if (patch?.fileName) meta.fileName = safeFileName(patch.fileName, meta.fileName);
    if (patch?.title) meta.title = patch.title.trim() || meta.title;
    if (patch?.artist) meta.artist = patch.artist.trim() || meta.artist;
    if (patch?.album !== undefined) meta.album = String(patch.album || "").trim();
    if (patch?.duration != null) meta.duration = Number(patch.duration) || meta.duration;
    if (patch?.bitrate !== undefined) {
      meta.bitrate = patch.bitrate == null ? null : Math.round(Number(patch.bitrate));
    }
    if (patch?.format) meta.format = String(patch.format).toUpperCase();
    if (patch?.contentType) meta.contentType = patch.contentType;

    const dest = path.join(entry.dir, storedTrackName(index, meta.fileName));
    await moveFile(tempPath, dest);
    meta.size = stat.size;
    meta.fileName = safeFileName(meta.fileName, `track-${index + 1}.mp3`);

    manifest.totalBytes = manifest.tracks.reduce((sum, t) => sum + (t.size || 0), 0);
    if (manifest.totalBytes > SHARE_MAX_PACKAGE_BYTES) {
      await fs.unlink(dest).catch(() => undefined);
      meta.size = 0;
      throw new Error("Shared playlist package is too large (max ~700 MB).");
    }
    await this.writeManifest(entry.dir, manifest);
    entry.totalBytes = manifest.totalBytes;
    return manifest;
  }

  async finalize(code: string): Promise<ShareManifest> {
    const loaded = await this.readManifest(code);
    if (!loaded) throw new Error("Share session not found or expired.");
    const {entry, manifest} = loaded;
    if (manifest.complete) return manifest;
    const missing = manifest.tracks.filter((t) => !t.size);
    if (missing.length) {
      throw new Error(
        `Missing ${missing.length} track file(s). Upload all tracks before finalizing.`,
      );
    }
    this.validateLimits(manifest.tracks.map((t) => ({duration: t.duration, size: t.size})));
    manifest.complete = true;
    manifest.totalBytes = manifest.tracks.reduce((sum, t) => sum + t.size, 0);
    manifest.totalDuration = manifest.tracks.reduce((sum, t) => sum + t.duration, 0);
    await this.writeManifest(entry.dir, manifest);
    entry.totalBytes = manifest.totalBytes;
    return manifest;
  }

  async abort(code: string): Promise<void> {
    const loaded = await this.readManifest(code);
    if (!loaded) return;
    this.index.delete(loaded.manifest.code);
    await fs.rm(loaded.entry.dir, {recursive: true, force: true}).catch(() => undefined);
  }

  /** Redeem-facing: only complete shares. */
  async getManifest(code: string): Promise<ShareManifest | null> {
    await this.purgeExpired();
    const loaded = await this.readManifest(code);
    if (!loaded) return null;
    if (!loaded.manifest.complete) return null;
    return loaded.manifest;
  }

  /** Uploader-facing: draft or complete. */
  async getSession(code: string): Promise<ShareManifest | null> {
    await this.purgeExpired();
    const loaded = await this.readManifest(code);
    return loaded?.manifest || null;
  }

  async openTrack(code: string, index: number): Promise<{meta: ShareTrackMeta; stream: ReturnType<typeof createReadStream>; absolutePath: string} | null> {
    const manifest = await this.getManifest(code);
    if (!manifest) return null;
    const meta = manifest.tracks.find((t) => t.index === index);
    if (!meta || !meta.size) return null;
    const entry = this.index.get(manifest.code);
    if (!entry) return null;
    const absolutePath = path.join(entry.dir, storedTrackName(index, meta.fileName));
    if (!existsSync(absolutePath)) return null;
    return {meta, stream: createReadStream(absolutePath), absolutePath};
  }
}

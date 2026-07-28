/**
 * Temporary playlist share packages (4-digit codes, 24h TTL).
 * Designed for Railway: disk under tmp, hard limits, sequential clients, auto-purge.
 */
import {promises as fs, createReadStream, existsSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomInt} from "node:crypto";

export const SHARE_MAX_TRACKS = 25;
export const SHARE_MAX_DURATION_SEC = 100 * 60;
export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
/** Soft package cap so a single share cannot fill the volume. */
export const SHARE_MAX_PACKAGE_BYTES = 700 * 1024 * 1024;
export const SHARE_MAX_TRACK_BYTES = 120 * 1024 * 1024;
export const SHARE_MAX_ACTIVE = 40;

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

  async create(input: {
    name: string;
    tracks: Array<{
      fileName: string;
      title: string;
      artist: string;
      album: string;
      duration: number;
      bitrate: number | null;
      format: string;
      contentType: string;
      buffer: Buffer;
    }>;
  }): Promise<ShareManifest> {
    await this.ensureReady();
    await this.purgeExpired();

    if (this.index.size >= SHARE_MAX_ACTIVE) {
      throw new Error("Share capacity reached on this host. Try again later.");
    }

    const sizes = input.tracks.map((t) => ({duration: t.duration, size: t.buffer.byteLength}));
    const {totalDuration, totalBytes} = this.validateLimits(sizes);

    for (const track of input.tracks) {
      if (track.buffer.byteLength > SHARE_MAX_TRACK_BYTES) {
        throw new Error(`Track “${track.title || track.fileName}” exceeds the per-file size limit.`);
      }
      if (!track.buffer.byteLength) throw new Error("A track file was empty.");
    }

    const code = this.allocateCode();
    const dir = path.join(this.root, code);
    await fs.mkdir(dir, {recursive: true});

    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS).toISOString();
    const tracks: ShareTrackMeta[] = [];

    try {
      for (let index = 0; index < input.tracks.length; index += 1) {
        const track = input.tracks[index];
        const fileName = safeFileName(track.fileName, `track-${index + 1}.mp3`);
        const storedName = `track-${String(index).padStart(2, "0")}${path.extname(fileName) || ".mp3"}`;
        await fs.writeFile(path.join(dir, storedName), track.buffer);
        tracks.push({
          index,
          fileName,
          title: (track.title || fileName).trim() || fileName,
          artist: (track.artist || "Unknown artist").trim() || "Unknown artist",
          album: (track.album || "").trim(),
          duration: Number(track.duration) || 0,
          bitrate: track.bitrate == null ? null : Math.round(Number(track.bitrate)),
          format: (track.format || path.extname(fileName).slice(1) || "audio").toUpperCase(),
          size: track.buffer.byteLength,
          contentType: track.contentType || "application/octet-stream",
        });
      }

      const manifest: ShareManifest = {
        code,
        name: (input.name || "Shared playlist").trim() || "Shared playlist",
        createdAt,
        expiresAt,
        trackCount: tracks.length,
        totalDuration,
        totalBytes,
        tracks,
      };
      await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      this.index.set(code, {code, dir, expiresAt: Date.parse(expiresAt), totalBytes});
      return manifest;
    } catch (error) {
      await fs.rm(dir, {recursive: true, force: true}).catch(() => undefined);
      throw error;
    }
  }

  async getManifest(code: string): Promise<ShareManifest | null> {
    await this.ensureReady();
    await this.purgeExpired();
    const normalized = String(code || "").trim();
    if (!/^\d{4}$/.test(normalized)) return null;
    const entry = this.index.get(normalized);
    if (!entry) return null;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(entry.dir, "manifest.json"), "utf8")) as ShareManifest;
      return raw;
    } catch {
      this.index.delete(normalized);
      return null;
    }
  }

  async openTrack(code: string, index: number): Promise<{meta: ShareTrackMeta; stream: ReturnType<typeof createReadStream>; absolutePath: string} | null> {
    const manifest = await this.getManifest(code);
    if (!manifest) return null;
    const meta = manifest.tracks.find((t) => t.index === index);
    if (!meta) return null;
    const entry = this.index.get(manifest.code);
    if (!entry) return null;
    const fileName = `track-${String(index).padStart(2, "0")}${path.extname(meta.fileName) || ".mp3"}`;
    const absolutePath = path.join(entry.dir, fileName);
    if (!existsSync(absolutePath)) return null;
    return {meta, stream: createReadStream(absolutePath), absolutePath};
  }
}

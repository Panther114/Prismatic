/**
 * Playlist share HTTP routes — per-track uploads (Railway 5‑min body limit safe).
 */
import type {Express, NextFunction, Request, Response} from "express";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomBytes} from "node:crypto";
import multer from "multer";
import {
  PlaylistShareStore,
  SHARE_MAX_CONCURRENT_UPLOADS,
  SHARE_MAX_DURATION_SEC,
  SHARE_MAX_TRACK_BYTES,
  SHARE_MAX_TRACKS,
} from "./playlistShare.js";

async function unlinkQuiet(filePath: string | undefined) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => undefined);
}

export async function mountShareRoutes(app: Express, options: {shareDir?: string} = {}) {
  const uploadRoot = path.join(os.tmpdir(), "prismatic-share-uploads");
  await fs.mkdir(uploadRoot, {recursive: true});

  const playlistShares = new PlaylistShareStore(options.shareDir || process.env.PRISMATIC_SHARE_DIR || undefined);

  const shareUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadRoot),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "") || ".bin";
        cb(null, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}${ext}`);
      },
    }),
    limits: {
      files: 1,
      fileSize: SHARE_MAX_TRACK_BYTES,
      fieldSize: 128 * 1024,
    },
  });

  let uploadsInFlight = 0;
  const tryAcquire = () => {
    if (uploadsInFlight >= SHARE_MAX_CONCURRENT_UPLOADS) return false;
    uploadsInFlight += 1;
    return true;
  };
  const release = () => {
    uploadsInFlight = Math.max(0, uploadsInFlight - 1);
  };

  /** Start a draft share (metadata only — no audio body). Fast JSON request. */
  app.post("/api/playlist-share/session", async (request, response, next) => {
    try {
      const name = typeof request.body?.name === "string" ? request.body.name : "Shared playlist";
      const tracks = Array.isArray(request.body?.tracks) ? request.body.tracks : [];
      if (!tracks.length) {
        response.status(400).json({error: "Playlist is empty."});
        return;
      }
      const meta = tracks.map((t: Record<string, unknown>, index: number) => ({
        fileName: String(t.fileName || t.file_name || `track-${index + 1}.mp3`),
        title: String(t.title || t.fileName || `Track ${index + 1}`),
        artist: String(t.artist || "Unknown artist"),
        album: String(t.album || ""),
        duration: Number(t.duration) || 0,
        bitrate: t.bitrate == null ? null : Number(t.bitrate),
        format: String(t.format || ""),
        contentType: String(t.contentType || t.content_type || "application/octet-stream"),
      }));
      const manifest = await playlistShares.beginSession({name, tracks: meta});
      response.status(201).json({
        code: manifest.code,
        expiresAt: manifest.expiresAt,
        trackCount: manifest.trackCount,
        totalDuration: manifest.totalDuration,
        name: manifest.name,
        complete: false,
        limits: {
          maxTracks: SHARE_MAX_TRACKS,
          maxDurationSec: SHARE_MAX_DURATION_SEC,
          maxTrackBytes: SHARE_MAX_TRACK_BYTES,
          ttlHours: 24,
          note: "Upload each track via PUT /api/playlist-share/:code/tracks/:index then POST .../complete",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Share session failed";
      response.status(400).json({error: message});
    }
  });

  /** Upload a single track (one request body ≤ ~120 MB, finishes within Railway's 5‑min cap). */
  app.put("/api/playlist-share/:code/tracks/:index", (request, response, next) => {
    if (!tryAcquire()) {
      response.status(429).json({
        error: "Share host is busy. Retry in a moment.",
        retryAfterSec: 10,
      });
      return;
    }
    shareUpload.single("audio")(request, response, (error) => {
      if (error) {
        release();
        response.status(400).json({error: error instanceof Error ? error.message : "Upload failed"});
        return;
      }
      void (async () => {
        const file = request.file;
        try {
          if (!file?.path) {
            response.status(400).json({error: "Missing audio file field “audio”."});
            return;
          }
          const index = Number(request.params.index);
          if (!Number.isInteger(index) || index < 0) {
            await unlinkQuiet(file.path);
            response.status(400).json({error: "Invalid track index."});
            return;
          }
          let patch: Record<string, unknown> = {};
          if (typeof request.body?.meta === "string") {
            try {
              patch = JSON.parse(request.body.meta) as Record<string, unknown>;
            } catch {
              // optional
            }
          }
          const started = Date.now();
          const manifest = await playlistShares.putTrack(request.params.code, index, file.path, {
            fileName: typeof patch.fileName === "string" ? patch.fileName : file.originalname,
            title: typeof patch.title === "string" ? patch.title : undefined,
            artist: typeof patch.artist === "string" ? patch.artist : undefined,
            album: typeof patch.album === "string" ? patch.album : undefined,
            duration: patch.duration != null ? Number(patch.duration) : undefined,
            bitrate: patch.bitrate === null || patch.bitrate === undefined ? null : Number(patch.bitrate),
            format: typeof patch.format === "string" ? patch.format : undefined,
            contentType: typeof patch.contentType === "string" ? patch.contentType : file.mimetype,
          });
          const track = manifest.tracks.find((t) => t.index === index);
          response.json({
            ok: true,
            code: manifest.code,
            index,
            size: track?.size || 0,
            elapsedMs: Date.now() - started,
            received: manifest.tracks.filter((t) => t.size > 0).length,
            trackCount: manifest.trackCount,
          });
        } catch (cause) {
          await unlinkQuiet(file?.path);
          response.status(400).json({error: cause instanceof Error ? cause.message : "Track upload failed"});
        } finally {
          release();
        }
      })().catch((err) => {
        release();
        next(err);
      });
    });
  });

  app.post("/api/playlist-share/:code/complete", async (request, response, next) => {
    try {
      const manifest = await playlistShares.finalize(request.params.code);
      response.json({
        code: manifest.code,
        expiresAt: manifest.expiresAt,
        trackCount: manifest.trackCount,
        totalDuration: manifest.totalDuration,
        totalBytes: manifest.totalBytes,
        name: manifest.name,
        complete: true,
      });
    } catch (error) {
      response.status(400).json({error: error instanceof Error ? error.message : "Finalize failed"});
    }
  });

  app.delete("/api/playlist-share/:code", async (request, response, next) => {
    try {
      await playlistShares.abort(request.params.code);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/playlist-share/:code", async (request, response, next) => {
    try {
      const draft = request.query.draft === "1" || request.query.draft === "true";
      const manifest = draft
        ? await playlistShares.getSession(request.params.code)
        : await playlistShares.getManifest(request.params.code);
      if (!manifest) {
        response.status(404).json({error: "Share code not found, incomplete, or expired."});
        return;
      }
      response.json(manifest);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/playlist-share/:code/tracks/:index", async (request, response, next) => {
    try {
      const index = Number(request.params.index);
      if (!Number.isInteger(index) || index < 0) {
        response.status(400).json({error: "Invalid track index."});
        return;
      }
      const opened = await playlistShares.openTrack(request.params.code, index);
      if (!opened) {
        response.status(404).json({error: "Track not found or share incomplete/expired."});
        return;
      }
      response.setHeader("Content-Type", opened.meta.contentType || "application/octet-stream");
      response.setHeader("Content-Length", String(opened.meta.size));
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(opened.meta.fileName)}`,
      );
      response.setHeader("Cache-Control", "private, no-store");
      opened.stream.on("error", next);
      opened.stream.pipe(response);
    } catch (error) {
      next(error);
    }
  });

  void playlistShares.purgeExpired().catch(() => undefined);
  setInterval(() => {
    void playlistShares.purgeExpired().catch(() => undefined);
  }, 15 * 60 * 1000).unref?.();

  setInterval(() => {
    void (async () => {
      try {
        const entries = await fs.readdir(uploadRoot, {withFileTypes: true});
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const full = path.join(uploadRoot, entry.name);
          const stat = await fs.stat(full).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    })();
  }, 30 * 60 * 1000).unref?.();

  return playlistShares;
}

export type {NextFunction, Request, Response};

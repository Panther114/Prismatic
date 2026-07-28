/**
 * Playlist share HTTP routes — disk-backed uploads, single concurrency slot.
 * Shared by full server (local/desktop) and slim cloud entry (Railway).
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
      destination: (_req, _file, cb) => {
        cb(null, uploadRoot);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "") || ".bin";
        cb(null, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}${ext}`);
      },
    }),
    limits: {
      files: SHARE_MAX_TRACKS,
      fileSize: SHARE_MAX_TRACK_BYTES,
      fieldSize: 64 * 1024,
    },
  });

  /** Serialize share creates so concurrent users cannot stack multi-hundred-MB jobs. */
  let uploadsInFlight = 0;

  app.post("/api/playlist-share", (request, response, next) => {
    if (uploadsInFlight >= SHARE_MAX_CONCURRENT_UPLOADS) {
      response.status(429).json({
        error: "Another playlist share is being uploaded. Retry in a moment.",
        retryAfterSec: 15,
      });
      return;
    }
    uploadsInFlight += 1;
    const release = () => {
      uploadsInFlight = Math.max(0, uploadsInFlight - 1);
    };

    shareUpload.array("audio", SHARE_MAX_TRACKS)(request, response, (error) => {
      if (error) {
        release();
        response.status(400).json({error: error instanceof Error ? error.message : "Upload failed"});
        return;
      }
      void (async () => {
        const files = (request.files as Express.Multer.File[] | undefined) || [];
        const cleanupTemps = async () => {
          await Promise.all(files.map((file) => unlinkQuiet(file.path)));
        };
        try {
          const name = typeof request.body?.name === "string" ? request.body.name : "Shared playlist";
          let metaList: Array<{
            fileName: string;
            title: string;
            artist: string;
            album: string;
            duration: number;
            bitrate: number | null;
            format: string;
            contentType: string;
          }> = [];
          try {
            const raw = typeof request.body?.tracks === "string" ? request.body.tracks : "[]";
            metaList = JSON.parse(raw) as typeof metaList;
          } catch {
            await cleanupTemps();
            response.status(400).json({error: "Invalid track metadata."});
            return;
          }
          if (!files.length || files.length !== metaList.length) {
            await cleanupTemps();
            response.status(400).json({error: "Track files and metadata count must match."});
            return;
          }

          // One track at a time into the share package (temps already on disk from multer).
          const tracks = files.map((file, index) => {
            const meta = metaList[index] || ({} as (typeof metaList)[number]);
            return {
              fileName: meta.fileName || file.originalname || `track-${index + 1}.mp3`,
              title: meta.title || meta.fileName || file.originalname || `Track ${index + 1}`,
              artist: meta.artist || "Unknown artist",
              album: meta.album || "",
              duration: Number(meta.duration) || 0,
              bitrate: meta.bitrate == null ? null : Number(meta.bitrate),
              format: meta.format || "",
              contentType: meta.contentType || file.mimetype || "application/octet-stream",
              tempPath: file.path,
            };
          });

          const manifest = await playlistShares.createFromTempFiles({name, tracks});
          // Temps that were moved are already gone; unlink any leftovers.
          await cleanupTemps();
          response.status(201).json({
            code: manifest.code,
            expiresAt: manifest.expiresAt,
            trackCount: manifest.trackCount,
            totalDuration: manifest.totalDuration,
            name: manifest.name,
            limits: {maxTracks: SHARE_MAX_TRACKS, maxDurationSec: SHARE_MAX_DURATION_SEC, ttlHours: 24},
          });
        } catch (cause) {
          await cleanupTemps();
          const message = cause instanceof Error ? cause.message : "Share failed";
          response.status(400).json({error: message});
        } finally {
          release();
        }
      })().catch((err) => {
        release();
        next(err);
      });
    });
  });

  app.get("/api/playlist-share/:code", async (request, response, next) => {
    try {
      const manifest = await playlistShares.getManifest(request.params.code);
      if (!manifest) {
        response.status(404).json({error: "Share code not found or expired."});
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
        response.status(404).json({error: "Track not found or share expired."});
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

  // Stale multer temps older than 2h (crashed uploads).
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

/** Express error typing helper — re-export unused Request/Response for consumers. */
export type {NextFunction, Request, Response};

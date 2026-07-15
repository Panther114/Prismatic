/**
 * Prismatic server
 *
 * Cloud / Railway (production): static SPA + /api/health only.
 *   Video encode never runs here — the browser does MediaRecorder export.
 * Local dev: Vite + music library / watch folders for convenience.
 *   Still no server-side video pipeline (no canvas/ffmpeg RAM spike).
 */
import {createServer as createHttpServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {promises as fs} from "node:fs";
import {createReadStream} from "node:fs";
import {spawn} from "node:child_process";
import express from "express";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isProduction = process.env.NODE_ENV === "production";
/** Full disk library only when not on Railway / forced cloud. */
const localFeatures =
  process.env.PRISMATIC_LOCAL === "1"
  || (!isProduction && !process.env.RAILWAY_ENVIRONMENT && process.env.PRISMATIC_CLOUD !== "1");
const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");
const app = express();
const server = createHttpServer(app);

app.use(express.json({limit: "256kb"}));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    name: "Prismatic",
    port,
    mode: localFeatures ? "local" : "cloud",
    /** Clients always export video in-browser. */
    clientExport: true,
  });
});

if (localFeatures) {
  const {MusicLibrary} = await import("./library.js");
  const {PlaylistRepository} = await import("./playlists.js");
  const {migrateProjectLibraryToShared, resolveLibraryPaths} = await import("./sharedPaths.js");
  const multer = (await import("multer")).default;

  // Same default paths for `pnpm dev`, `pnpm start`, and Electron (see sharedPaths.ts).
  const paths = resolveLibraryPaths(root);
  const {musicDirectory, stateDirectory, outputDirectory, dataRoot} = paths;

  const migration = await migrateProjectLibraryToShared(root, paths);
  if (migration.seededMusic > 0) {
    console.log(`Seeded ${migration.seededMusic} track(s) into shared library: ${musicDirectory}`);
  }
  if (migration.migratedState) {
    console.log(`Migrated library state into: ${stateDirectory}`);
  }
  console.log(`Prismatic library · ${musicDirectory}`);

  const library = new MusicLibrary(root, musicDirectory, stateDirectory);
  const playlists = new PlaylistRepository(stateDirectory);

  const storage = multer.diskStorage({
    destination: musicDirectory,
    filename: (_request, file, callback) => {
      const safe = path.basename(file.originalname).replace(/[^\p{L}\p{N}._ -]+/gu, "-");
      callback(null, safe || `audio-${Date.now()}.mp3`);
    },
  });
  const upload = multer({
    storage,
    limits: {fileSize: 1024 * 1024 * 1024, files: 50},
    fileFilter: (_request, file, callback) => {
      const allowed = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]);
      callback(null, allowed.has(path.extname(file.originalname).toLowerCase()));
    },
  });

  app.get("/api/tracks", async (_request, response, next) => {
    try {
      response.json(await library.list());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/library/meta", async (_request, response, next) => {
    try {
      response.json({
        generation: library.generationValue(),
        watchFolders: await library.getWatchFolders(),
        musicDirectory,
        dataRoot,
        mode: "local",
        clientExport: true,
        /** Web + Electron share this folder by default. */
        sharedLibrary: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:sourceId/*relativePath", async (request, response, next) => {
    try {
      const sourceId = String(request.params.sourceId || "");
      const raw = (request.params as {relativePath?: string | string[]}).relativePath;
      const joined = Array.isArray(raw) ? raw.join("/") : String(raw || "");
      const relativeParts = joined.split("/").filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
      });
      const absolute = library.resolveMedia(sourceId, relativeParts);
      if (!absolute) return response.status(404).json({error: "Media not found"});
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile()) return response.status(404).json({error: "Media not found"});

      const range = request.headers.range;
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Cache-Control", "public, max-age=3600");

      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          if (start >= stat.size || end >= stat.size || start > end) {
            response.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
            return;
          }
          response.status(206);
          response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          response.setHeader("Content-Length", String(end - start + 1));
          createReadStream(absolute, {start, end}).pipe(response);
          return;
        }
      }

      response.setHeader("Content-Length", String(stat.size));
      createReadStream(absolute).pipe(response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tracks/:id/cover", async (request, response, next) => {
    try {
      const track = await library.get(request.params.id);
      if (!track) return response.status(404).end();
      const cover = await library.cover(track);
      if (!cover) return response.status(404).end();
      response.set({"Content-Type": cover.mime, "Cache-Control": "public, max-age=3600"}).send(cover.data);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tracks/:id/waveform", async (request, response, next) => {
    try {
      const track = await library.get(request.params.id);
      if (!track) return response.status(404).end();
      response.set("Cache-Control", "public, max-age=3600").json(await library.waveform(track));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import", upload.array("audio", 50), async (request, response, next) => {
    try {
      const files = (request.files as Express.Multer.File[] | undefined) || [];
      await library.noteImportedFiles(files.map((file) => file.filename || file.originalname));
      response.status(201).json(await library.list());
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/tracks/:id", async (request, response, next) => {
    try {
      const track = await library.update(request.params.id, {title: request.body.title, artist: request.body.artist});
      if (!track) return response.status(404).json({error: "Track not found"});
      response.json(track);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/tracks/:id", async (request, response, next) => {
    try {
      const deleteFile = String(request.query.deleteFile ?? "0") === "1";
      const ok = await library.remove(request.params.id, {deleteFile});
      if (!ok) return response.status(404).json({error: "Track not found"});
      await playlists.stripTrack(request.params.id);
      response.json(await library.list());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/playlists", async (_request, response, next) => {
    try {
      response.json(await playlists.list());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/playlists", async (request, response, next) => {
    try {
      const name = String(request.body?.name || "New playlist");
      const trackIds = Array.isArray(request.body?.trackIds) ? request.body.trackIds.map(String) : [];
      response.status(201).json(await playlists.create({name, trackIds}));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/playlists/:id", async (request, response, next) => {
    try {
      const updated = await playlists.update(request.params.id, {
        name: request.body?.name,
        trackIds: request.body?.trackIds,
      });
      if (!updated) return response.status(404).json({error: "Playlist not found"});
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/playlists/:id", async (request, response, next) => {
    try {
      const nextList = await playlists.remove(request.params.id);
      if (!nextList) return response.status(404).json({error: "Playlist not found"});
      response.json(nextList);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/watch-folders", async (_request, response, next) => {
    try {
      response.json(await library.getWatchFolders());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/watch-folders", async (request, response, next) => {
    try {
      const folderPath = String(request.body.path || "").trim();
      response.status(201).json(await library.addWatchFolder(folderPath));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/watch-folders/:id", async (request, response, next) => {
    try {
      response.json(await library.removeWatchFolder(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/watch-folders/browse", async (_request, response, next) => {
    try {
      if (process.platform !== "win32") {
        return response.status(400).json({error: "Folder browser is only available on Windows — paste a path instead."});
      }
      const scriptPath = path.join(root, "server", "browse-folder.ps1");
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        {windowsHide: false, stdio: ["ignore", "pipe", "pipe"]},
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
      }, 120_000);
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
      child.on("error", (error) => {
        clearTimeout(timer);
        next(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const selected = out.replace(/^\uFEFF/, "").trim();
        if (selected) {
          response.json({path: selected});
          return;
        }
        if (code === 0) {
          response.status(200).json({path: null, cancelled: true});
          return;
        }
        response.status(500).json({error: err.trim() || "Folder browser failed. Paste a path instead."});
      });
    } catch (error) {
      next(error);
    }
  });

  // Server-side render intentionally removed — masters encode in the browser.
  app.post("/api/render", (_request, response) => {
    response.status(410).json({
      error: "Server-side render is disabled. Prismatic exports video in your browser to keep the host light.",
      clientExport: true,
    });
  });
  app.get("/api/jobs", (_request, response) => response.json([]));
  app.get("/api/renders", (_request, response) => response.json([]));
  app.post("/api/open-output", (_request, response) => {
    const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [outputDirectory], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    response.status(204).end();
  });

  process.on("exit", () => library.dispose());
} else {
  // Cloud: no disk library endpoints (return empty / clear errors).
  app.get("/api/tracks", (_request, response) => response.json([]));
  app.get("/api/library/meta", (_request, response) => response.json({
    generation: 0,
    watchFolders: [],
    musicDirectory: "",
    mode: "cloud",
    clientExport: true,
  }));
  app.post("/api/import", (_request, response) => {
    response.status(400).json({
      error: "Cloud mode keeps audio in your browser — import via the app UI (client-side).",
      clientExport: true,
    });
  });
  app.post("/api/render", (_request, response) => {
    response.status(410).json({error: "Use browser export.", clientExport: true});
  });
  app.get("/api/jobs", (_request, response) => response.json([]));
  app.get("/api/renders", (_request, response) => response.json([]));
  app.get("/api/playlists", (_request, response) => response.json([]));
  app.post("/api/playlists", (_request, response) => {
    response.status(400).json({error: "Cloud mode stores playlists in the browser."});
  });
}

if (isProduction) {
  const dist = path.join(root, "dist");
  app.use(express.static(dist, {fallthrough: true, maxAge: "1h"}));
  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    if (request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(dist, "index.html"), (error) => {
      if (error) next(error);
    });
  });
} else {
  const viteMod = await import("vite");
  const vite = await viteMod.createServer({
    root,
    server: {middlewareMode: true, hmr: {server}},
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({error: error instanceof Error ? error.message : "Unexpected server error"});
});

server.listen(port, host, () => {
  console.log(`Prismatic (${localFeatures ? "local" : "cloud"}) · http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log("Video export runs in the browser — server stays lightweight.");
});

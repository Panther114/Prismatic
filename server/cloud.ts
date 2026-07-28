/**
 * Slim Railway / cloud entrypoint.
 *
 * Only: health + SPA static + playlist share (disk-backed).
 * Never loads MusicLibrary, music-metadata, watch folders, or Vite.
 */
import {createServer as createHttpServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {promises as fs} from "node:fs";
import express from "express";
import {mountShareRoutes} from "./shareRoutes.js";

// Force cloud semantics even if mis-set in the environment.
process.env.PRISMATIC_CLOUD = "1";
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const root = process.env.PRISMATIC_APP_ROOT
  ? path.resolve(process.env.PRISMATIC_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || "0.0.0.0";
const app = express();
const server = createHttpServer(app);

app.use(express.json({limit: "256kb"}));

await mountShareRoutes(app);

app.get("/api/health", async (_request, response) => {
  const distIndex = path.join(root, "dist", "index.html");
  let distOk = false;
  let distMarker = "";
  try {
    const html = await fs.readFile(distIndex, "utf8");
    distOk = true;
    const m = html.match(/assets\/index-[^"]+\.js/);
    distMarker = m?.[0] || "index.html";
  } catch {
    distOk = false;
  }
  response.json({
    ok: true,
    name: "Prismatic",
    port,
    mode: "cloud",
    clientExport: true,
    version: process.env.PRISMATIC_APP_VERSION || process.env.npm_package_version || null,
    desktop: false,
    appRoot: root,
    distOk,
    distMarker,
    slim: true,
  });
});

// Cloud stubs — library lives in the browser (IndexedDB).
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
app.delete("/api/library", (_request, response) => response.json({
  tracks: [],
  playlists: [],
  watchFolders: [],
  deletedManagedFiles: 0,
  preservedExternalFiles: 0,
  failedManagedFiles: [],
}));
app.post("/api/playlists", (_request, response) => {
  response.status(400).json({error: "Cloud mode stores playlists in the browser."});
});

const dist = path.join(root, "dist");
app.use(express.static(dist, {
  fallthrough: true,
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    }
  },
}));
app.use((request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (request.path.startsWith("/api/")) return next();
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.sendFile(path.join(dist, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({error: error instanceof Error ? error.message : "Unexpected server error"});
});

server.listen(port, host, () => {
  console.log(`Prismatic (cloud slim) · http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log("SPA + health + disk playlist-share only — no library stack.");
});

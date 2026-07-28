/**
 * Railway / cloud entrypoint — health only (no website, no playlist share).
 * Desktop app is the product; playlists transfer via local zip files.
 */
import {createServer as createHttpServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";
import express from "express";

process.env.PRISMATIC_CLOUD = "1";
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const root = process.env.PRISMATIC_APP_ROOT
  ? path.resolve(process.env.PRISMATIC_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || "0.0.0.0";

const app = express();
const server = createHttpServer(app);

app.use(express.json({limit: "64kb"}));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    name: "Prismatic",
    port,
    mode: "cloud",
    role: "health-only",
    clientExport: true,
    version: process.env.PRISMATIC_APP_VERSION || process.env.npm_package_version || null,
    desktop: false,
    appRoot: root,
    slim: true,
    website: false,
    share: false,
  });
});

app.use((request, response) => {
  if (request.path.startsWith("/api/")) {
    response.status(404).json({error: "Not found", share: false});
    return;
  }
  response.status(404).type("text").send(
    "Prismatic desktop app only. Use Playlists → Export zip / Import zip for transfers.",
  );
});

server.listen(port, host, () => {
  console.log(`Prismatic health-only · http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});

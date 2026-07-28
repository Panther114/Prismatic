/**
 * Railway share-only entrypoint (cold-start / Serverless friendly).
 *
 * - No SPA / no static website
 * - No music library stack
 * - Health + playlist share only
 * - Avoid outbound chatter so Railway Serverless can sleep after ~10m idle
 */
import {createServer as createHttpServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";
import express from "express";
import {mountShareRoutes} from "./shareRoutes.js";

process.env.PRISMATIC_CLOUD = "1";
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const root = process.env.PRISMATIC_APP_ROOT
  ? path.resolve(process.env.PRISMATIC_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || "0.0.0.0";

/** Public origin Railway assigns (used for health + desktop clients). */
function publicOrigin(): string | null {
  const explicit = process.env.PRISMATIC_SHARE_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!explicit) return null;
  if (explicit.startsWith("http://") || explicit.startsWith("https://")) return explicit.replace(/\/$/, "");
  return `https://${explicit.replace(/\/$/, "")}`;
}

const app = express();
const server = createHttpServer(app);

// CORS: desktop (Tauri) and any future clients call this host cross-origin.
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.setHeader("Access-Control-Max-Age", "86400");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.use(express.json({limit: "256kb"}));

await mountShareRoutes(app);

app.get("/api/health", (_request, response) => {
  const origin = publicOrigin();
  response.json({
    ok: true,
    name: "Prismatic",
    port,
    mode: "cloud",
    role: "share-only",
    clientExport: true,
    version: process.env.PRISMATIC_APP_VERSION || process.env.npm_package_version || null,
    desktop: false,
    appRoot: root,
    slim: true,
    website: false,
    serverless: true,
    sharePublicUrl: origin,
  });
});

// Explicit 404 for everything else (no SPA fallback — website removed).
app.use((request, response) => {
  if (request.path.startsWith("/api/")) {
    response.status(404).json({error: "Not found", shareOnly: true});
    return;
  }
  response.status(404).type("text").send(
    "Prismatic share API only. Use the desktop app. Health: GET /api/health",
  );
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({error: error instanceof Error ? error.message : "Unexpected server error"});
});

// Keep the process quiet so Railway Serverless can detect inactivity
// (no telemetry, no periodic outbound requests).
server.listen(port, host, () => {
  const origin = publicOrigin() || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log(`Prismatic share-only · ${origin}`);
  console.log("Endpoints: GET /api/health · POST /api/playlist-share · GET /api/playlist-share/:code");
  console.log("Enable Railway Serverless (App Sleeping) for cold-start idle RAM ≈ 0.");
});

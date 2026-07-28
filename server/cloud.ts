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

// Single-track uploads must not hit Node's default 5‑minute requestTimeout.
// Railway still enforces its own ~5‑min body limit per request — so we upload per-track.
server.requestTimeout = 0; // disable Node request timeout (ms); 0 = no timeout
server.headersTimeout = 15 * 60 * 1000;
server.keepAliveTimeout = 120_000;

// CORS: desktop (Tauri) and any future clients call this host cross-origin.
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
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
  console.log("Endpoints: health · session · PUT tracks/:i · complete · GET share/:code");
  console.log("Per-track uploads (Railway 5‑min body limit). Enable Serverless for idle RAM ≈ 0.");
});

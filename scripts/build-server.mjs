/**
 * Bundle Express servers:
 * - dist-server/index.mjs  — full local/desktop (library + share + optional Vite)
 * - dist-server/cloud.mjs  — Railway slim (health + SPA + disk share only)
 *
 * IMPORTANT: Do NOT leave npm packages external for the full desktop bundle.
 * Only native / optional binaries stay external.
 */
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {promises as fs} from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const viteDir = path.dirname(require.resolve("vite/package.json"));
const esbuildPath = require.resolve("esbuild", {paths: [viteDir, root]});
const esbuild = await import(pathToFileURL(esbuildPath).href);

const outDir = path.join(root, "dist-server");
await fs.mkdir(outDir, {recursive: true});

const withSourceMap = process.env.PRISMATIC_SERVER_SOURCEMAP === "1";
const minify = process.env.PRISMATIC_SERVER_MINIFY !== "0";

const banner = {
  js: `
import { createRequire as __prismaticCreateRequire } from 'node:module';
import { fileURLToPath as __prismaticFileURLToPath } from 'node:url';
import { dirname as __prismaticDirname } from 'node:path';
const require = __prismaticCreateRequire(import.meta.url);
const __filename = __prismaticFileURLToPath(import.meta.url);
const __dirname = __prismaticDirname(__filename);
`.trim(),
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  sourcemap: withSourceMap,
  minify,
  logLevel: "info",
  banner,
};

// --- Full server (desktop / local production) ---
const fullOut = path.join(outDir, "index.mjs");
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "server", "index.ts")],
  outfile: fullOut,
  external: [
    "electron",
    "vite",
    "@napi-rs/canvas",
    "@napi-rs/canvas-*",
    "fsevents",
  ],
});

const fullCode = await fs.readFile(fullOut, "utf8");
if (/from\s+["']music-metadata["']/.test(fullCode) || /require\(["']music-metadata["']\)/.test(fullCode)) {
  console.error("FAIL: dist-server/index.mjs still imports music-metadata externally");
  process.exit(1);
}
if (!fullCode.includes("parseFile") && !fullCode.includes("music-metadata") && !fullCode.includes("parseBlob")) {
  console.warn("WARN: full bundle may not include music-metadata symbols (check manually)");
}
console.log(`Server bundle (full)  → ${fullOut} (${(fullCode.length / 1024).toFixed(0)} KB)`);

// --- Slim cloud (Railway) ---
const cloudOut = path.join(outDir, "cloud.mjs");
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, "server", "cloud.ts")],
  outfile: cloudOut,
  external: [
    "electron",
    "vite",
    "@napi-rs/canvas",
    "@napi-rs/canvas-*",
    "fsevents",
    // Library stack must never ship in the cloud binary.
    "music-metadata",
  ],
});

const cloudCode = await fs.readFile(cloudOut, "utf8");
if (cloudCode.includes("MusicLibrary") || cloudCode.includes("music-metadata") || cloudCode.includes("parseFile")) {
  console.error("FAIL: dist-server/cloud.mjs contains library/metadata stack");
  process.exit(1);
}
if (!cloudCode.includes("playlist-share") && !cloudCode.includes("PlaylistShare")) {
  console.warn("WARN: cloud bundle may be missing playlist-share routes");
}
console.log(`Server bundle (cloud) → ${cloudOut} (${(cloudCode.length / 1024).toFixed(0)} KB)`);

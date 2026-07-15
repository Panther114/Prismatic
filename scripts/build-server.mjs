/**
 * Bundle the Express server for Electron into a single ESM file.
 *
 * IMPORTANT: Do NOT leave npm packages external. When dist-server is
 * asarUnpacked, Node cannot resolve packages that only live inside app.asar
 * (e.g. "Cannot find package 'music-metadata'").
 *
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

const outfile = path.join(root, "dist-server", "index.mjs");
await fs.mkdir(path.dirname(outfile), {recursive: true});

await esbuild.build({
  entryPoints: [path.join(root, "server", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  // Bundle express, music-metadata, multer, etc. into one file.
  packages: "bundle",
  external: [
    "electron",
    "vite",
    // optional native canvases / platform binaries
    "@napi-rs/canvas",
    "@napi-rs/canvas-*",
    "fsevents",
  ],
  // Allow marked external packages to stay external even if nested
  sourcemap: true,
  logLevel: "info",
  banner: {
    js: `
import { createRequire as __prismaticCreateRequire } from 'node:module';
import { fileURLToPath as __prismaticFileURLToPath } from 'node:url';
import { dirname as __prismaticDirname } from 'node:path';
const require = __prismaticCreateRequire(import.meta.url);
const __filename = __prismaticFileURLToPath(import.meta.url);
const __dirname = __prismaticDirname(__filename);
`.trim(),
  },
});

// Sanity: music-metadata must not remain as a bare external import
const code = await fs.readFile(outfile, "utf8");
if (/from\s+["']music-metadata["']/.test(code) || /require\(["']music-metadata["']\)/.test(code)) {
  console.error("FAIL: dist-server still imports music-metadata externally");
  process.exit(1);
}
if (!code.includes("parseFile") && !code.includes("music-metadata") && !code.includes("parseBlob")) {
  console.warn("WARN: bundle may not include music-metadata symbols (check manually)");
}

console.log(`Server bundle → ${outfile} (${(code.length / 1024).toFixed(0)} KB)`);

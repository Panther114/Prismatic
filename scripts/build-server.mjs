/**
 * Bundle the Express server for Electron (no tsx at runtime).
 * Output: dist-server/index.mjs — local sources bundled, node_modules external.
 */
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {promises as fs} from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
// esbuild is nested under vite in pnpm; resolve via vite's install graph
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
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

console.log(`Server bundle → ${outfile}`);

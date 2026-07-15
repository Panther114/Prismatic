/**
 * Prove the Windows installer is the NEW build (not a stale 1.0.0 one-click artifact).
 */
import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const releaseDir = path.join(root, "release-build");

const entries = await fs.readdir(releaseDir).catch(() => []);
const installer = entries.find((name) =>
  /\.exe$/i.test(name)
  && /setup/i.test(name)
  && name.includes(version)
  && !name.includes(".__uninstaller")
  && !/blockmap/i.test(name),
);

if (!installer) {
  console.error(`FAIL: No installer for version ${version} in release/`);
  console.error("Found:", entries.join(", ") || "(empty)");
  process.exit(1);
}

const installerPath = path.join(releaseDir, installer);
const stat = await fs.stat(installerPath);
if (stat.size < 20 * 1024 * 1024) {
  console.error(`FAIL: Installer too small (${stat.size} bytes) — packaging likely incomplete`);
  process.exit(1);
}
console.log(`OK installer: ${installer} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

const asarPath = path.join(releaseDir, "win-unpacked", "resources", "app.asar");
await fs.access(asarPath);
const bin = await fs.readFile(asarPath);
const text = bin.toString("utf8");

const markers = [
  "Export visuals",
  "Your sets",
  "Open player",
  "studio-view",
  version, // injected __APP_VERSION__
];

// Markers may live in asar or asar.unpacked (dist is unpacked for Express).
const unpackedDir = path.join(releaseDir, "win-unpacked", "resources", "app.asar.unpacked");
let searchText = text;
try {
  const distIndex = await fs.readFile(path.join(unpackedDir, "dist", "index.html"), "utf8");
  searchText += `\n${distIndex}`;
  console.log(`OK unpacked dist/index.html:\n${distIndex.trim()}`);
  // Also scan main JS bundle on disk
  const assets = await fs.readdir(path.join(unpackedDir, "dist", "assets"));
  const mainJs = assets.find((n) => /^index-.*\.js$/.test(n));
  if (mainJs) {
    const js = await fs.readFile(path.join(unpackedDir, "dist", "assets", mainJs), "utf8");
    searchText += js;
    console.log(`OK unpacked SPA bundle: ${mainJs} (${(js.length / 1024).toFixed(0)} KB)`);
  } else {
    console.error("FAIL: no index-*.js under app.asar.unpacked/dist/assets");
    process.exit(1);
  }
} catch (error) {
  console.error("FAIL: dist not unpacked to app.asar.unpacked/dist — Express/desktop will break or stale-cache");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const marker of markers) {
  if (!searchText.includes(marker)) {
    console.error(`FAIL: package missing marker "${marker}"`);
    process.exit(1);
  }
  console.log(`OK package contains: ${marker}`);
}

// Guard against shipping the old fixed name
const legacy = entries.filter((n) => n === "Prismatic Setup 1.0.0.exe");
if (legacy.length && version !== "1.0.0") {
  console.warn(`WARN: legacy artifact still present: ${legacy.join(", ")} (safe to delete; use the ${version} file)`);
}

console.log("");
console.log(`VERIFY PASS — Prismatic ${version}`);
console.log(installerPath);

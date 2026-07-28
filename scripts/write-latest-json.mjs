/**
 * Build Tauri static updater manifest (latest.json) from signed release artifacts.
 *
 * Usage:
 *   node scripts/write-latest-json.mjs --version 2.1.2 --tag v2.1.2 --out artifacts/latest.json \
 *     --windows-x64 path/to/setup.exe --windows-x64-sig path/to/setup.exe.sig \
 *     --darwin-aarch64 path/to/app.tar.gz --darwin-aarch64-sig path/to/app.tar.gz.sig
 *
 * URL base defaults to GitHub Releases for Panther114/Prismatic.
 */
import {promises as fs} from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const version = arg("version");
const tag = arg("tag", version ? `v${version}` : null);
const outPath = arg("out", "latest.json");
const notes = arg("notes", "");
const repo = arg("repo", "Panther114/Prismatic");
const dryRun = flag("dry-run");

if (!version || !tag) {
  console.error("Usage: write-latest-json.mjs --version X.Y.Z --tag vX.Y.Z [--out latest.json] ...");
  process.exit(1);
}

const platforms = {};

async function addPlatform(key, filePath, sigPath) {
  if (!filePath || !sigPath) return;
  const fileName = path.basename(filePath);
  const signature = (await fs.readFile(sigPath, "utf8")).trim();
  if (!signature) {
    throw new Error(`Empty signature file: ${sigPath}`);
  }
  // Tauri expects the raw minisign signature string in latest.json
  platforms[key] = {
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${fileName}`,
  };
  console.log(`+ ${key} → ${fileName} (sig ${signature.length} chars)`);
}

await addPlatform("windows-x86_64", arg("windows-x64"), arg("windows-x64-sig"));
await addPlatform("darwin-aarch64", arg("darwin-aarch64"), arg("darwin-aarch64-sig"));
await addPlatform("darwin-x86_64", arg("darwin-x86_64"), arg("darwin-x86_64-sig"));
await addPlatform("linux-x86_64", arg("linux-x64"), arg("linux-x64-sig"));

if (Object.keys(platforms).length === 0) {
  throw new Error("No platforms provided — pass at least one --windows-x64 / --darwin-aarch64 pair.");
}

const manifest = {
  version,
  notes: notes || `Prismatic ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (dryRun) {
  process.stdout.write(json);
} else {
  await fs.mkdir(path.dirname(path.resolve(outPath)), {recursive: true});
  await fs.writeFile(outPath, json, "utf8");
  console.log(`Wrote ${outPath}`);
}

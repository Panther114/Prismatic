/**
 * Validate a Tauri latest.json updater manifest before publishing.
 */
import {promises as fs} from "node:fs";
import path from "node:path";

const file = process.argv[2] || "latest.json";
const raw = await fs.readFile(file, "utf8");
const data = JSON.parse(raw);

const errors = [];
if (!data.version || typeof data.version !== "string") {
  errors.push("missing version");
}
if (!data.platforms || typeof data.platforms !== "object") {
  errors.push("missing platforms");
} else {
  for (const [key, value] of Object.entries(data.platforms)) {
    if (!/^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/.test(key)) {
      errors.push(`invalid platform key: ${key}`);
    }
    if (!value?.url || !/^https:\/\//.test(value.url)) {
      errors.push(`${key}: url must be https`);
    }
    if (!value?.signature || typeof value.signature !== "string" || value.signature.length < 32) {
      errors.push(`${key}: signature missing or too short`);
    }
  }
  if (Object.keys(data.platforms).length === 0) {
    errors.push("platforms is empty");
  }
}

if (errors.length) {
  console.error(`Invalid updater manifest ${path.basename(file)}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`OK ${path.basename(file)} · v${data.version} · ${Object.keys(data.platforms).join(", ")}`);

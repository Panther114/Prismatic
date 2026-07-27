import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import path from "node:path";

const pkg = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
const installer = path.resolve(
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Prismatic_${pkg.version}_x64-setup.exe`,
);
const bytes = await fs.readFile(installer);
const sizeMiB = bytes.byteLength / 1024 / 1024;
if (sizeMiB > 20) {
  throw new Error(`Installer is ${sizeMiB.toFixed(2)} MiB; the release gate is 20 MiB.`);
}
if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
  throw new Error("Installer does not have a Windows PE header.");
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const checksumFile = `${installer}.sha256`;
await fs.writeFile(checksumFile, `${sha256}  ${path.basename(installer)}\n`, "utf8");
console.log(`Verified ${path.basename(installer)} · ${sizeMiB.toFixed(2)} MiB`);
console.log(`SHA-256 ${sha256}`);
console.log(`Checksum ${checksumFile}`);

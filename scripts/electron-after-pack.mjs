/**
 * Strip anything electron-builder still injected (e.g. optional @napi-rs/canvas
 * resolved from the monorepo lockfile) so the installed app stays lean.
 * Runtime never needs node_modules — dist-server is fully bundled.
 */
import {promises as fs} from "node:fs";
import path from "node:path";

/** @param {import('electron-builder').AfterPackContext} context */
export default async function afterPack(context) {
  const resources = path.join(context.appOutDir, "resources");
  const targets = [
    path.join(resources, "app.asar.unpacked", "node_modules"),
    path.join(resources, "app", "node_modules"),
    path.join(context.appOutDir, "node_modules"),
  ];

  for (const target of targets) {
    try {
      await fs.rm(target, {recursive: true, force: true});
      console.log(`afterPack: removed ${path.relative(context.appOutDir, target)}`);
    } catch {
      // absent is fine
    }
  }
}

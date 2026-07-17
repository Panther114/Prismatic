/**
 * Stage a minimal Electron app directory for packaging.
 *
 * Why: electron-builder auto-copies package.json production dependencies into
 * the asar. Our runtime is already self-contained (dist SPA + dist-server bundle),
 * so shipping node_modules (canvas, esbuild, vite, typescript, …) only bloats
 * the installer. Stage a package.json with zero dependencies and only the files
 * the desktop shell needs.
 */
import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "desktop-stage");

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), {recursive: true});
  await fs.copyFile(from, to);
}

async function copyDir(from, to) {
  await fs.mkdir(to, {recursive: true});
  const entries = await fs.readdir(from, {withFileTypes: true});
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else if (entry.isFile()) {
      // Never ship server sourcemaps in the desktop package.
      if (entry.name.endsWith(".map")) continue;
      // Skip log noise from local server runs.
      if (/\.(log)$/i.test(entry.name)) continue;
      await copyFile(src, dest);
    }
  }
}

async function main() {
  const required = [
    path.join(root, "dist", "index.html"),
    path.join(root, "dist-server", "index.mjs"),
    path.join(root, "electron", "main.cjs"),
  ];
  for (const p of required) {
    if (!(await exists(p))) {
      console.error(`stage-desktop: missing ${path.relative(root, p)} — run pnpm build && pnpm build:server first`);
      process.exit(1);
    }
  }

  await fs.rm(stage, {recursive: true, force: true});
  await fs.mkdir(stage, {recursive: true});

  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const slimPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    author: pkg.author,
    description: pkg.description,
    main: "electron/main.cjs",
    // Intentionally empty: nothing is resolved from node_modules at runtime.
    dependencies: {},
  };
  await fs.writeFile(path.join(stage, "package.json"), `${JSON.stringify(slimPkg, null, 2)}\n`, "utf8");

  await copyDir(path.join(root, "dist"), path.join(stage, "dist"));
  await copyDir(path.join(root, "dist-server"), path.join(stage, "dist-server"));

  await fs.mkdir(path.join(stage, "electron"), {recursive: true});
  await copyFile(path.join(root, "electron", "main.cjs"), path.join(stage, "electron", "main.cjs"));

  // Icons (also referenced via buildResources; keep a copy for runtime resolveAppIcon).
  for (const name of ["icon.ico", "icon.png"]) {
    const icon = path.join(root, "build", name);
    if (await exists(icon)) {
      await copyFile(icon, path.join(stage, "build", name));
    }
  }

  // Fallback assets if not already inside dist/ (vite usually copies public/).
  for (const name of ["music-note.png", "favicon.svg"]) {
    const inDist = path.join(stage, "dist", name);
    if (!(await exists(inDist))) {
      const fromPublic = path.join(root, "public", name);
      if (await exists(fromPublic)) {
        await copyFile(fromPublic, inDist);
      }
    }
  }

  // Sanity: no node_modules in stage.
  if (await exists(path.join(stage, "node_modules"))) {
    console.error("stage-desktop: node_modules leaked into stage");
    process.exit(1);
  }

  const size = async (dir) => {
    let total = 0;
    const walk = async (d) => {
      const entries = await fs.readdir(d, {withFileTypes: true});
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else total += (await fs.stat(p)).size;
      }
    };
    await walk(dir);
    return total;
  };

  const bytes = await size(stage);
  console.log(`stage-desktop → ${stage}`);
  console.log(`  staged app payload: ${(bytes / 1024 / 1024).toFixed(2)} MB (no node_modules)`);
}

await main();

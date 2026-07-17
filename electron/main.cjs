/**
 * Prismatic Electron shell.
 *
 * Critical: SPA must load from the *packaged* dist, never a stale service-worker cache.
 * - Prefer app.asar.unpacked for dist/ (real files; Express-static is reliable)
 * - Wipe Cache Storage + Service Workers before first paint
 * - Never register SW inside Electron (see src/main.tsx)
 */
const {app, BrowserWindow, Menu, shell, dialog, nativeImage, session} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const {pathToFileURL} = require("node:url");

const PORT = Number(process.env.PRISMATIC_PORT || 4188);
const HOST = "127.0.0.1";

/** @type {BrowserWindow | null} */
let mainWindow = null;
let serverStarted = false;

function logPath() {
  try {
    return path.join(app.getPath("userData"), "prismatic-desktop.log");
  } catch {
    return path.join(os.tmpdir(), "prismatic-desktop.log");
  }
}

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logPath(), line, "utf8");
  } catch {
    // ignore
  }
  console.error(message);
}

/**
 * Package content root for static SPA + server bundle.
 * When dist is asarUnpacked, must use app.asar.unpacked (not the asar archive).
 */
function appRoot() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, "..");
  }
  const asarPath = app.getAppPath(); // .../resources/app.asar
  const unpacked = asarPath.replace(/app\.asar$/i, "app.asar.unpacked");
  const unpackedIndex = path.join(unpacked, "dist", "index.html");
  const asarIndex = path.join(asarPath, "dist", "index.html");
  if (fs.existsSync(unpackedIndex)) {
    logLine(`Using unpacked app root: ${unpacked}`);
    return unpacked;
  }
  if (fs.existsSync(asarIndex)) {
    logLine(`Using asar app root: ${asarPath}`);
    return asarPath;
  }
  // Last resort: resources dir
  logLine(`WARN dist/index.html missing under asar and unpacked; appPath=${asarPath}`);
  return asarPath;
}

function readPackageVersion(root) {
  try {
    const pkgPath = path.join(root, "package.json");
    // package.json usually remains inside asar even when dist is unpacked
    const candidates = [
      pkgPath,
      path.join(app.getAppPath(), "package.json"),
      path.join(path.dirname(app.getAppPath()), "app.asar", "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")).version || "0";
      }
    }
  } catch {
    // ignore
  }
  return "0";
}

function sharedLibraryRoot() {
  if (process.env.PRISMATIC_DATA_DIR) {
    return path.resolve(process.env.PRISMATIC_DATA_DIR);
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, "Music", "Prismatic");
}

function resolveAppIcon() {
  const roots = [appRoot(), app.getAppPath(), path.resolve(__dirname, "..")];
  const names = ["build/icon.ico", "build/icon.png", "public/favicon.svg"];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) return image;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}

function waitForHealth(timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://${HOST}:${PORT}/api/health`, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            logLine(`Health body: ${body.slice(0, 300)}`);
            resolve(body);
            return;
          }
          retry();
        });
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Server did not become ready within ${timeoutMs}ms. See log: ${logPath()}`));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

/**
 * Wipe Chromium service workers + HTTP cache so upgrades cannot show a stale SPA shell.
 * This was the root cause of "installer updates but UI stays old".
 */
async function clearStaleWebCaches() {
  const ses = session.defaultSession;
  try {
    await ses.clearCache();
    logLine("Cleared HTTP cache");
  } catch (error) {
    logLine(`clearCache failed: ${error}`);
  }
  try {
    await ses.clearStorageData({
      storages: [
        "serviceworkers",
        "cachestorage",
        "shadercache",
        "cookies",
      ],
    });
    logLine("Cleared service workers + Cache Storage");
  } catch (error) {
    logLine(`clearStorageData failed: ${error}`);
  }
}

async function startServerInProcess() {
  if (serverStarted) return;
  const resources = appRoot();
  const dataDir = sharedLibraryRoot();
  const musicDir = process.env.PRISMATIC_MUSIC_DIR
    ? path.resolve(process.env.PRISMATIC_MUSIC_DIR)
    : dataDir;
  const version = readPackageVersion(resources);

  process.env.NODE_ENV = "production";
  process.env.PRISMATIC_LOCAL = "1";
  process.env.PORT = String(PORT);
  process.env.HOST = HOST;
  process.env.PRISMATIC_DATA_DIR = dataDir;
  process.env.PRISMATIC_MUSIC_DIR = musicDir;
  process.env.PRISMATIC_APP_ROOT = resources;
  process.env.PRISMATIC_APP_VERSION = version;
  process.env.PRISMATIC_DESKTOP = "1";

  const distIndex = path.join(resources, "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `SPA missing at ${distIndex}. Packaging did not include dist/. Rebuild with pnpm dist:win.`,
    );
  }
  const distHtml = fs.readFileSync(distIndex, "utf8");
  logLine(`dist/index.html head: ${distHtml.replace(/\s+/g, " ").slice(0, 220)}`);

  const candidates = [
    path.join(resources, "dist-server", "index.mjs"),
    path.join(app.getAppPath(), "dist-server", "index.mjs"),
    path.join(path.resolve(__dirname, ".."), "dist-server", "index.mjs"),
  ];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) {
    throw new Error(
      `Server bundle missing (dist-server/index.mjs). Looked in:\n${candidates.join("\n")}`,
    );
  }

  // Server bundle (dist-server/index.mjs) is fully self-contained — no node_modules at runtime.

  logLine(`Loading server bundle: ${entry}`);
  logLine(`appRoot=${resources} version=${version} music=${musicDir}`);

  await import(pathToFileURL(entry).href);
  serverStarted = true;
  logLine("Server module loaded");
}

async function createWindow(version) {
  const icon = resolveAppIcon();
  // Partition keyed by version so Chromium storage cannot leak across upgrades
  const partition = `persist:prismatic-v${version}`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#05070c",
    autoHideMenuBar: true,
    icon,
    title: `Prismatic ${version}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      // Avoid disk HTTP cache replaying old hashed assets within a session
      backgroundThrottling: true,
    },
    show: false,
  });

  Menu.setApplicationMenu(null);
  if (process.platform === "win32") {
    app.setAppUserModelId("app.prismatic.desktop");
  }

  // Also clear this partition (versioned) on first open
  try {
    await mainWindow.webContents.session.clearCache();
    await mainWindow.webContents.session.clearStorageData({
      storages: ["serviceworkers", "cachestorage"],
    });
  } catch (error) {
    logLine(`partition clear failed: ${error}`);
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    void shell.openExternal(url);
    return {action: "deny"};
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine(`Window failed to load: ${code} ${desc} url=${url}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    // Log document title / inject version check
    void mainWindow?.webContents
      .executeJavaScript(`document.title + ' | ' + (window.__APP_VERSION__ || document.body?.innerText?.slice(0,80) || '')`)
      .then((t) => logLine(`Renderer loaded: ${t}`))
      .catch(() => undefined);
  });

  // Cache-bust navigation so no intermediary returns a stale index.html
  const url = `http://${HOST}:${PORT}/?desktop=1&v=${encodeURIComponent(version)}&t=${Date.now()}`;
  logLine(`loadURL ${url}`);
  await mainWindow.loadURL(url);
}

async function boot() {
  try {
    fs.mkdirSync(path.dirname(logPath()), {recursive: true});
  } catch {
    // ignore
  }
  logLine("Boot start");
  try {
    await clearStaleWebCaches();
    await startServerInProcess();
    const health = await waitForHealth();
    logLine(`Health OK: ${health}`);
    const version = process.env.PRISMATIC_APP_VERSION || readPackageVersion(appRoot());
    await createWindow(version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    logLine(`Boot failed: ${message}`);
    if (stack) logLine(stack);
    dialog.showErrorBox(
      "Prismatic failed to start",
      `${message}\n\nLog file:\n${logPath()}`,
    );
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    void boot();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void boot();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

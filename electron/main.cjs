/**
 * Prismatic Electron shell.
 * Starts the production server in-process (no child Electron/Node process),
 * then opens the BrowserWindow. Fixes packaged boot + Task Manager icon.
 */
const {app, BrowserWindow, Menu, shell, dialog, nativeImage} = require("electron");
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

/** Package root (app.asar when packaged). */
function appRoot() {
  if (app.isPackaged) return app.getAppPath();
  return path.resolve(__dirname, "..");
}

function sharedLibraryRoot() {
  if (process.env.PRISMATIC_DATA_DIR) {
    return path.resolve(process.env.PRISMATIC_DATA_DIR);
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, "Music", "Prismatic");
}

function resolveAppIcon() {
  const roots = [appRoot(), path.resolve(__dirname, "..")];
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
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
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
 * Load bundled server in this process (single Prismatic.exe — correct taskbar/Task Manager icon).
 */
async function startServerInProcess() {
  if (serverStarted) return;
  const resources = appRoot();
  const dataDir = sharedLibraryRoot();
  const musicDir = process.env.PRISMATIC_MUSIC_DIR
    ? path.resolve(process.env.PRISMATIC_MUSIC_DIR)
    : dataDir;

  process.env.NODE_ENV = "production";
  process.env.PRISMATIC_LOCAL = "1";
  process.env.PORT = String(PORT);
  process.env.HOST = HOST;
  process.env.PRISMATIC_DATA_DIR = dataDir;
  process.env.PRISMATIC_MUSIC_DIR = musicDir;
  process.env.PRISMATIC_APP_ROOT = resources;

  const candidates = [
    path.join(resources, "dist-server", "index.mjs"),
    path.join(path.resolve(__dirname, ".."), "dist-server", "index.mjs"),
  ];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) {
    throw new Error(
      `Server bundle missing (dist-server/index.mjs). Rebuild with pnpm electron:build.\nLooked in:\n${candidates.join("\n")}`,
    );
  }

  logLine(`Loading server bundle: ${entry}`);
  logLine(`appRoot=${resources} music=${musicDir}`);

  // ESM dynamic import works from CJS main under Electron/Node 20+
  await import(pathToFileURL(entry).href);
  serverStarted = true;
  logLine("Server module loaded");
}

function createWindow() {
  const icon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#05070c",
    autoHideMenuBar: true,
    icon,
    title: "Prismatic",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  Menu.setApplicationMenu(null);
  if (process.platform === "win32" && icon) {
    app.setAppUserModelId("app.prismatic.desktop");
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    void shell.openExternal(url);
    return {action: "deny"};
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    logLine(`Window failed to load: ${code} ${desc}`);
  });

  void mainWindow.loadURL(`http://${HOST}:${PORT}`);
}

async function boot() {
  try {
    fs.mkdirSync(path.dirname(logPath()), {recursive: true});
  } catch {
    // ignore
  }
  logLine("Boot start");
  try {
    await startServerInProcess();
    await waitForHealth();
    logLine("Health OK");
    createWindow();
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

// Single-instance lock so double-click reuses the same process/icon
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

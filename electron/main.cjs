/**
 * Prismatic Electron shell — starts the local production server, then opens a window.
 *
 * Music + playlists: %USERPROFILE%\Music\Prismatic (same as local web).
 */
const {app, BrowserWindow, Menu, shell, dialog, nativeImage} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const {spawn} = require("node:child_process");
const http = require("node:http");
const os = require("node:os");

const PORT = Number(process.env.PRISMATIC_PORT || 4188);
const HOST = "127.0.0.1";

/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

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

/** App resources (package.json, dist, public) — may be inside app.asar */
function appRoot() {
  if (app.isPackaged) return app.getAppPath();
  return path.resolve(__dirname, "..");
}

/**
 * Unpacked tree for running the Node server (tsx + server TS sources).
 * dist still loaded via PRISMATIC_APP_ROOT → asar.
 */
function serverRoot() {
  const base = appRoot();
  if (app.isPackaged && base.includes("app.asar")) {
    return base.replace("app.asar", "app.asar.unpacked");
  }
  return base;
}

function sharedLibraryRoot() {
  if (process.env.PRISMATIC_DATA_DIR) {
    return path.resolve(process.env.PRISMATIC_DATA_DIR);
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, "Music", "Prismatic");
}

function resolveAppIcon() {
  const candidates = [
    path.join(appRoot(), "build", "icon.png"),
    path.join(appRoot(), "build", "icon.ico"),
    path.join(serverRoot(), "build", "icon.png"),
    path.join(appRoot(), "public", "favicon.svg"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
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

function waitForHealth(timeoutMs = 60000) {
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
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Server did not become ready within ${timeoutMs}ms. See log: ${logPath()}`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function startServer() {
  const resources = appRoot();
  const runtime = serverRoot();
  const dataDir = sharedLibraryRoot();
  const musicDir = process.env.PRISMATIC_MUSIC_DIR
    ? path.resolve(process.env.PRISMATIC_MUSIC_DIR)
    : dataDir;

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PRISMATIC_LOCAL: "1",
    PORT: String(PORT),
    HOST,
    PRISMATIC_DATA_DIR: dataDir,
    PRISMATIC_MUSIC_DIR: musicDir,
    /** Static SPA + public assets live here (asar-safe). */
    PRISMATIC_APP_ROOT: resources,
  };

  const bootstrap = path.join(runtime, "electron", "bootstrap.mjs");
  const fallbackTsx = path.join(runtime, "node_modules", "tsx", "dist", "cli.mjs");
  const serverEntry = path.join(runtime, "server", "index.ts");

  let args;
  if (fs.existsSync(bootstrap)) {
    args = [bootstrap];
    logLine(`Starting server via bootstrap: ${bootstrap}`);
  } else {
    let tsxCli = fallbackTsx;
    try {
      tsxCli = require.resolve("tsx/cli");
    } catch {
      // use fallback
    }
    args = [tsxCli, serverEntry];
    logLine(`Starting server via tsx: ${tsxCli} ${serverEntry}`);
  }

  logLine(`appRoot=${resources} serverRoot=${runtime} music=${musicDir}`);

  serverProcess = spawn(process.execPath, args, {
    cwd: runtime,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (chunk) => logLine(`[server] ${chunk.toString().trimEnd()}`));
  serverProcess.stderr?.on("data", (chunk) => logLine(`[server:err] ${chunk.toString().trimEnd()}`));

  serverProcess.on("exit", (code, signal) => {
    logLine(`Server exited code=${code} signal=${signal}`);
    serverProcess = null;
  });

  serverProcess.on("error", (error) => {
    logLine(`Server spawn error: ${error.message}`);
  });
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  Menu.setApplicationMenu(null);

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
  startServer();
  try {
    await waitForHealth();
    logLine("Health OK");
    createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`Boot failed: ${message}`);
    dialog.showErrorBox(
      "Prismatic failed to start",
      `${message}\n\nLog file:\n${logPath()}`,
    );
    app.quit();
  }
}

app.whenReady().then(() => {
  void boot();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void boot();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // ignore
    }
  }
});

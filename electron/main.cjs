/**
 * Prismatic Electron shell — starts the local production server, then opens a window.
 * Installer is stock NSIS (no custom UI). Offline: PRISMATIC_LOCAL=1 + userData paths.
 */
const {app, BrowserWindow, Menu, shell} = require("electron");
const path = require("node:path");
const {spawn} = require("node:child_process");
const http = require("node:http");

const PORT = Number(process.env.PRISMATIC_PORT || 4188);
const HOST = "127.0.0.1";

/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

function projectRoot() {
  const base = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
  // tsx + server must run from unpacked paths when asar is enabled
  if (app.isPackaged && base.includes("app.asar")) {
    return base.replace("app.asar", "app.asar.unpacked");
  }
  return base;
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
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Prismatic server did not become ready in time."));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function startServer() {
  const root = projectRoot();
  const dataDir = path.join(app.getPath("userData"), "data");
  const musicDir = path.join(dataDir, "music");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PRISMATIC_LOCAL: "1",
    PORT: String(PORT),
    HOST,
    PRISMATIC_DATA_DIR: dataDir,
    PRISMATIC_MUSIC_DIR: musicDir,
  };

  // Prefer tsx CLI so we can ship TypeScript server sources without a separate compile step.
  let tsxCli;
  try {
    tsxCli = require.resolve("tsx/cli");
  } catch {
    tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  }
  const serverEntry = path.join(root, "server", "index.ts");

  serverProcess = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: root,
    env,
    stdio: app.isPackaged ? "ignore" : "inherit",
    windowsHide: true,
  });

  serverProcess.on("exit", (code) => {
    if (code && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      console.error(`Prismatic server exited with code ${code}`);
    }
    serverProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#05070c",
    autoHideMenuBar: true,
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

  void mainWindow.loadURL(`http://${HOST}:${PORT}`);
}

async function boot() {
  startServer();
  await waitForHealth();
  createWindow();
}

app.whenReady().then(() => {
  void boot().catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void boot().catch(console.error);
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


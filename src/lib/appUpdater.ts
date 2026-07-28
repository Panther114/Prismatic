import {check, type DownloadEvent, type Update} from "@tauri-apps/plugin-updater";
import {relaunch} from "@tauri-apps/plugin-process";
import {isTauri} from "../api";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type UpdateProgress = {
  downloaded: number;
  total: number | null;
  percent: number | null;
};

export type UpdateSnapshot = {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  notes: string;
  progress: UpdateProgress;
  error: string | null;
  checkedAt: number | null;
};

type Listener = (snapshot: UpdateSnapshot) => void;

const AUTO_CHECK_DELAY_MS = 4_000;
const AUTO_CHECK_STORAGE_KEY = "prismatic.update.autoCheckedAt";
const AUTO_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

function emptyProgress(): UpdateProgress {
  return {downloaded: 0, total: null, percent: null};
}

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message || "Update failed";
  return String(cause || "Update failed");
}

class AppUpdater {
  private listeners = new Set<Listener>();
  private pending: Update | null = null;
  private checkPromise: Promise<UpdateSnapshot> | null = null;
  private installPromise: Promise<void> | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: UpdateSnapshot = {
    phase: "idle",
    currentVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "",
    availableVersion: null,
    notes: "",
    progress: emptyProgress(),
    error: null,
    checkedAt: null,
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): UpdateSnapshot {
    return this.snapshot;
  }

  isDesktop(): boolean {
    return isTauri;
  }

  /** Quiet background check after startup. Never auto-installs. */
  scheduleStartupCheck(): void {
    if (!isTauri) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (!this.shouldAutoCheck()) return;
      void this.checkForUpdates({reason: "auto"}).catch(() => {
        /* quiet — errors only surface on manual check */
      });
    }, AUTO_CHECK_DELAY_MS);
  }

  dispose(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  }

  async checkForUpdates(options: {reason?: "auto" | "manual"} = {}): Promise<UpdateSnapshot> {
    if (!isTauri) {
      return this.setSnapshot({
        phase: "error",
        error: "Updates are only available in the desktop app.",
        availableVersion: null,
        notes: "",
        progress: emptyProgress(),
      });
    }

    if (this.installPromise) {
      return this.snapshot;
    }

    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.checkPromise = this.runCheck(options.reason ?? "manual");
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  async downloadAndInstall(): Promise<void> {
    if (!isTauri) {
      throw new Error("Updates are only available in the desktop app.");
    }
    if (this.installPromise) {
      return this.installPromise;
    }
    if (!this.pending) {
      const snap = await this.checkForUpdates({reason: "manual"});
      if (snap.phase !== "available" || !this.pending) {
        throw new Error(snap.error || "No update is available to install.");
      }
    }

    this.installPromise = this.runInstall();
    try {
      await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  async relaunchApp(): Promise<void> {
    if (!isTauri) return;
    await relaunch();
  }

  dismissAvailable(): void {
    if (this.snapshot.phase === "available" || this.snapshot.phase === "error" || this.snapshot.phase === "up-to-date") {
      this.setSnapshot({
        phase: "idle",
        error: null,
        // keep availableVersion so Settings can still show badge if needed
      });
    }
  }

  private async runCheck(reason: "auto" | "manual"): Promise<UpdateSnapshot> {
    this.setSnapshot({
      phase: "checking",
      error: null,
      progress: emptyProgress(),
    });

    try {
      const update = await check({timeout: 25_000});
      const checkedAt = Date.now();
      if (reason === "auto") {
        try {
          localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(checkedAt));
        } catch {
          /* ignore quota / private mode */
        }
      }

      if (!update) {
        this.pending = null;
        return this.setSnapshot({
          phase: "up-to-date",
          availableVersion: null,
          notes: "",
          progress: emptyProgress(),
          error: null,
          checkedAt,
          currentVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : this.snapshot.currentVersion,
        });
      }

      this.pending = update;
      return this.setSnapshot({
        phase: "available",
        availableVersion: update.version,
        currentVersion: update.currentVersion || this.snapshot.currentVersion,
        notes: (update.body || "").trim(),
        progress: emptyProgress(),
        error: null,
        checkedAt,
      });
    } catch (cause) {
      this.pending = null;
      // Network / 404 on first release is expected; stay quiet for auto checks.
      const message = formatError(cause);
      if (reason === "auto") {
        return this.setSnapshot({
          phase: "idle",
          error: null,
          checkedAt: Date.now(),
        });
      }
      return this.setSnapshot({
        phase: "error",
        error: message,
        availableVersion: null,
        notes: "",
        progress: emptyProgress(),
        checkedAt: Date.now(),
      });
    }
  }

  private async runInstall(): Promise<void> {
    const update = this.pending;
    if (!update) {
      throw new Error("No pending update.");
    }

    let downloaded = 0;
    let total: number | null = null;

    this.setSnapshot({
      phase: "downloading",
      error: null,
      progress: {downloaded: 0, total: null, percent: null},
    });

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            downloaded = 0;
            this.setSnapshot({
              phase: "downloading",
              progress: {
                downloaded,
                total,
                percent: total && total > 0 ? 0 : null,
              },
            });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            this.setSnapshot({
              phase: "downloading",
              progress: {
                downloaded,
                total,
                percent: total && total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : null,
              },
            });
            break;
          case "Finished":
            this.setSnapshot({
              phase: "installing",
              progress: {
                downloaded: total ?? downloaded,
                total,
                percent: 100,
              },
            });
            break;
          default:
            break;
        }
      });

      this.pending = null;
      // On Windows the process typically exits during install; on other platforms we relaunch.
      this.setSnapshot({
        phase: "ready",
        progress: {
          downloaded: total ?? downloaded,
          total,
          percent: 100,
        },
        error: null,
      });
      await relaunch();
    } catch (cause) {
      const message = formatError(cause);
      this.setSnapshot({
        phase: "error",
        error: message,
      });
      throw new Error(message);
    }
  }

  private shouldAutoCheck(): boolean {
    try {
      const raw = localStorage.getItem(AUTO_CHECK_STORAGE_KEY);
      if (!raw) return true;
      const last = Number(raw);
      if (!Number.isFinite(last)) return true;
      return Date.now() - last >= AUTO_CHECK_COOLDOWN_MS;
    } catch {
      return true;
    }
  }

  private setSnapshot(partial: Partial<UpdateSnapshot>): UpdateSnapshot {
    this.snapshot = {...this.snapshot, ...partial};
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
    return this.snapshot;
  }
}

export const appUpdater = new AppUpdater();

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

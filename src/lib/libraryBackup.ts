import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {open, save} from "@tauri-apps/plugin-dialog";
import {isTauri} from "../api";

export type BackupExportOptions = {
  includeAudio: boolean;
  includePlaylists: boolean;
  includeSettings: boolean;
};

export type BackupExportResult = {
  path: string;
  tracks: number;
  bytes: number;
  missing: string[];
  cancelled: boolean;
};

export type BackupImportOptions = {
  restorePlaylists: boolean;
  restoreSettings: boolean;
};

export type BackupImportResult = {
  tracksAdded: number;
  tracksDuplicate: number;
  tracksFailed: string[];
  playlistsAdded: number;
  playlistsSkipped: number;
  settingsRestored: boolean;
  createdAt: string;
  cancelled: boolean;
};

type Progress = (message: string, ratio: number) => void;

export function backupFileName(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10);
  return `Prismatic-library-${stamp}.prismatic-backup.zip`;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function summarizeExport(result: BackupExportResult) {
  if (result.cancelled) return "Backup cancelled. No file was written.";
  const base = `Backed up ${result.tracks} track${result.tracks === 1 ? "" : "s"} (${formatBytes(result.bytes)}).`;
  return result.missing.length
    ? `${base} ${result.missing.length} file${result.missing.length === 1 ? " was" : "s were"} missing and skipped.`
    : base;
}

export function summarizeImport(result: BackupImportResult) {
  if (result.cancelled) return "Restore cancelled. Tracks restored so far were kept.";
  const parts = [`${result.tracksAdded} track${result.tracksAdded === 1 ? "" : "s"} added`];
  if (result.tracksDuplicate) parts.push(`${result.tracksDuplicate} already in library`);
  if (result.playlistsAdded) parts.push(`${result.playlistsAdded} playlist${result.playlistsAdded === 1 ? "" : "s"} restored`);
  if (result.playlistsSkipped) parts.push(`${result.playlistsSkipped} playlist${result.playlistsSkipped === 1 ? "" : "s"} already present`);
  if (result.settingsRestored) parts.push("settings restored");
  if (result.tracksFailed.length) parts.push(`${result.tracksFailed.length} failed`);
  return `${parts.join(" · ")}.`;
}

async function withProgress<T>(onProgress: Progress | undefined, run: () => Promise<T>): Promise<T> {
  const unlisten = await listen<{message?: string; progress?: number}>("zip-progress", (event) => {
    const message = event.payload?.message;
    if (message) onProgress?.(message, typeof event.payload?.progress === "number" ? event.payload.progress : 0);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

function requireDesktop(feature: string) {
  if (!isTauri) throw new Error(`${feature} is available in the desktop app.`);
}

export async function exportLibraryBackup(options: BackupExportOptions, onProgress?: Progress): Promise<BackupExportResult> {
  requireDesktop("Library backup");
  const dest = await save({
    defaultPath: backupFileName(),
    filters: [{name: "Prismatic backup", extensions: ["zip"]}],
  });
  if (!dest) throw new Error("Backup cancelled.");
  return withProgress(onProgress, () =>
    invoke<BackupExportResult>("export_library_backup", {destPath: String(dest), options}),
  );
}

export async function importLibraryBackup(options: BackupImportOptions, onProgress?: Progress): Promise<BackupImportResult> {
  requireDesktop("Library restore");
  const selected = await open({
    multiple: false,
    filters: [{name: "Prismatic backup", extensions: ["zip"]}],
  });
  if (!selected) throw new Error("Restore cancelled.");
  return withProgress(onProgress, () =>
    invoke<BackupImportResult>("import_library_backup", {zipPath: String(selected), options}),
  );
}

export async function cancelLibraryBackup() {
  if (isTauri) await invoke("cancel_library_backup");
}

export async function exportLibraryList(format: "csv" | "m3u8"): Promise<number> {
  requireDesktop("Library list export");
  const dest = await save({
    defaultPath: `Prismatic-library.${format}`,
    filters: [{name: format === "csv" ? "CSV spreadsheet" : "M3U8 playlist", extensions: [format]}],
  });
  if (!dest) throw new Error("Export cancelled.");
  return invoke<number>("export_library_list", {destPath: String(dest), format});
}

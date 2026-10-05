import {describe, expect, it} from "vitest";
import {backupFileName, formatBytes, summarizeExport, summarizeImport} from "./libraryBackup";

describe("libraryBackup helpers", () => {
  it("names backups by date", () => {
    expect(backupFileName(new Date("2026-10-05T12:00:00Z"))).toBe("Prismatic-library-2026-10-05.prismatic-backup.zip");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("summarizes exports including skipped files and cancellation", () => {
    expect(summarizeExport({path: "x", tracks: 1, bytes: 2048, missing: [], cancelled: false})).toBe("Backed up 1 track (2.0 KB).");
    expect(summarizeExport({path: "x", tracks: 3, bytes: 1024, missing: ["a.mp3"], cancelled: false})).toContain("1 file was missing");
    expect(summarizeExport({path: "x", tracks: 0, bytes: 0, missing: [], cancelled: true})).toContain("cancelled");
  });

  it("summarizes imports", () => {
    const text = summarizeImport({
      tracksAdded: 2, tracksDuplicate: 1, tracksFailed: ["bad.mp3"], playlistsAdded: 1,
      playlistsSkipped: 0, settingsRestored: true, createdAt: "", cancelled: false,
    });
    expect(text).toBe("2 tracks added · 1 already in library · 1 playlist restored · settings restored · 1 failed.");
  });
});

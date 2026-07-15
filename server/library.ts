import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {watch, type FSWatcher} from "node:fs";
import {promises as fs} from "node:fs";
import path from "node:path";
import {promisify} from "node:util";
import {parseFile} from "music-metadata";
import type {Track} from "./types.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]);
const execFileAsync = promisify(execFile);
const PARSE_CONCURRENCY = 4;

export type WatchFolder = {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
};

type Override = {title?: string; artist?: string};
type Overrides = Record<string, Override>;
type Settings = {
  watchFolders: WatchFolder[];
  /** Soft-hidden track ids (kept off the library without deleting the file). */
  hidden: string[];
};

type SourceRoot = {
  id: string;
  absolutePath: string;
  label: string;
  isDefault: boolean;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  track: Track;
  absolutePath: string;
};

const idFor = (sourceId: string, relativePath: string) =>
  createHash("sha1")
    .update(`${sourceId}:${relativePath.replaceAll("\\", "/").toLowerCase()}`)
    .digest("hex")
    .slice(0, 14);

const sourceIdFor = (absolutePath: string) =>
  createHash("sha1").update(path.resolve(absolutePath).toLowerCase()).digest("hex").slice(0, 10);

async function exactDuration(file: string, fallback: number) {
  // Prefer embedded duration — spawning ffprobe per file is the cold-scan bottleneck.
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  try {
    const {stdout} = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], {windowsHide: true, timeout: 8000});
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : fallback;
  } catch {
    return fallback;
  }
}

const AUDIO_FILE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;

/** Collect audio paths under `root`, including only folders up to `maxDepth` below root. */
async function collectAudioFiles(rootDir: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const visit = async (directory: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(directory, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(full, depth + 1);
        continue;
      }
      if (entry.isFile() && AUDIO_FILE.test(entry.name)) out.push(full);
    }
  };
  await visit(rootDir, 0);
  return out;
}

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      // Skip dot dirs (.prismatic) and shared layout folders (output, etc.)
      if (entry.name.startsWith(".")) return [] as string[];
      const lower = entry.name.toLowerCase();
      if (lower === "output" || lower === "node_modules" || lower === "dist" || lower === "release") {
        return [] as string[];
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      return [fullPath];
    }),
  );
  return nested.flat();
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export class MusicLibrary {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly watchers = new Map<string, FSWatcher>();
  private settings: Settings = {watchFolders: [], hidden: []};
  private settingsLoaded = false;
  private listInflight: Promise<Track[]> | null = null;
  private dirty = true;
  private generation = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedList: Track[] = [];

  constructor(
    private readonly root: string,
    private readonly musicDirectory: string,
    private readonly stateDirectory: string,
  ) {}

  private get overridesPath() {
    return path.join(this.stateDirectory, "library.json");
  }

  private get settingsPath() {
    return path.join(this.stateDirectory, "settings.json");
  }

  private async ensureSettings() {
    if (this.settingsLoaded) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.settingsPath, "utf8")) as Partial<Settings>;
      this.settings = {
        watchFolders: Array.isArray(raw.watchFolders) ? raw.watchFolders.filter((f) => f?.path && f?.id) : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
      };
    } catch {
      this.settings = {watchFolders: [], hidden: []};
    }
    this.settingsLoaded = true;
    this.resyncWatchers();
  }

  private async writeSettings() {
    await fs.mkdir(this.stateDirectory, {recursive: true});
    await fs.writeFile(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
  }

  private async readOverrides(): Promise<Overrides> {
    try {
      return JSON.parse(await fs.readFile(this.overridesPath, "utf8")) as Overrides;
    } catch {
      return {};
    }
  }

  private markDirty() {
    this.dirty = true;
    this.generation += 1;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // Coalesce filesystem storms (copying many files) into one rescan.
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.list().catch((error) => console.warn("Library rescan failed:", error));
    }, 450);
  }

  private resyncWatchers() {
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();

    const roots = [
      this.musicDirectory,
      ...this.settings.watchFolders.filter((f) => f.enabled).map((f) => f.path),
    ];

    for (const rootPath of roots) {
      const key = path.resolve(rootPath).toLowerCase();
      if (this.watchers.has(key)) continue;
      try {
        const watcher = watch(rootPath, {recursive: true}, () => this.markDirty());
        watcher.on("error", () => {
          // Broken watch (drive unplugged) — fall back to poll via dirty flag only.
          try { watcher.close(); } catch { /* ignore */ }
          this.watchers.delete(key);
        });
        this.watchers.set(key, watcher);
      } catch (error) {
        console.warn(`Could not watch ${rootPath}:`, error);
      }
    }
  }

  private sources(): SourceRoot[] {
    const defaults: SourceRoot[] = [{
      id: "music",
      absolutePath: path.resolve(this.musicDirectory),
      label: "Shared library",
      isDefault: true,
    }];
    const extra = this.settings.watchFolders
      .filter((folder) => folder.enabled)
      .map((folder) => ({
        id: folder.id,
        absolutePath: path.resolve(folder.path),
        label: folder.label || path.basename(folder.path) || folder.path,
        isDefault: false,
      }));
    // Deduplicate paths that equal the default music dir
    const musicKey = defaults[0].absolutePath.toLowerCase();
    return [
      ...defaults,
      ...extra.filter((source) => source.absolutePath.toLowerCase() !== musicKey),
    ];
  }

  generationValue() {
    return this.generation;
  }

  async getWatchFolders(): Promise<WatchFolder[]> {
    await this.ensureSettings();
    return this.settings.watchFolders.map((folder) => ({...folder}));
  }

  async addWatchFolder(rawPath: string): Promise<WatchFolder[]> {
    await this.ensureSettings();
    const absolute = path.resolve(rawPath.trim());
    if (!absolute) throw new Error("Folder path is required");
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("Path is not a folder");

    const id = sourceIdFor(absolute);
    if (path.resolve(this.musicDirectory).toLowerCase() === absolute.toLowerCase()) {
      throw new Error("That folder is already the built-in music library");
    }
    if (this.settings.watchFolders.some((folder) => folder.id === id || path.resolve(folder.path).toLowerCase() === absolute.toLowerCase())) {
      throw new Error("Folder is already watched");
    }

    this.settings.watchFolders.push({
      id,
      path: absolute,
      label: path.basename(absolute) || absolute,
      enabled: true,
    });
    await this.writeSettings();
    this.resyncWatchers();
    this.markDirty();
    return this.getWatchFolders();
  }

  async removeWatchFolder(id: string): Promise<WatchFolder[]> {
    await this.ensureSettings();
    this.settings.watchFolders = this.settings.watchFolders.filter((folder) => folder.id !== id);
    await this.writeSettings();
    // Drop cache entries for that source
    for (const [key, entry] of this.cache) {
      if (entry.track.id && key.startsWith(`${id}:`)) this.cache.delete(key);
    }
    // Also clear by scanning track source in cache keys — keys are absolute paths
    for (const [key, entry] of this.cache) {
      if (entry.track.mediaUrl.includes(`/api/media/${id}/`)) this.cache.delete(key);
    }
    this.resyncWatchers();
    this.markDirty();
    return this.getWatchFolders();
  }

  private async buildTrack(source: SourceRoot, absoluteFile: string, overrides: Overrides): Promise<Track | null> {
    const relativePath = path.relative(source.absolutePath, absoluteFile).replaceAll("\\", "/");
    if (relativePath.startsWith("..")) return null;
    const id = idFor(source.id, relativePath);
    if (this.settings.hidden.includes(id)) return null;

    try {
      const stat = await fs.stat(absoluteFile);
      const cacheKey = absoluteFile.toLowerCase();
      const cached = this.cache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        const track = {
          ...cached.track,
          title: overrides[id]?.title?.trim() || cached.track.title,
          artist: overrides[id]?.artist?.trim() || cached.track.artist,
        };
        return track;
      }

      const metadata = await parseFile(absoluteFile, {duration: true, skipCovers: true});
      const duration = await exactDuration(absoluteFile, metadata.format.duration ?? 0);
      const baseName = path.basename(absoluteFile, path.extname(absoluteFile));
      const folderLabel = path.dirname(relativePath) === "."
        ? source.label
        : `${source.label}/${path.dirname(relativePath).replaceAll("\\", "/")}`;

      const track: Track = {
        id,
        sourceId: source.id,
        fileName: path.basename(absoluteFile),
        relativePath,
        folder: folderLabel,
        mediaUrl: `/api/media/${source.id}/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
        coverUrl: `/api/tracks/${id}/cover`,
        waveformUrl: `/api/tracks/${id}/waveform`,
        title: overrides[id]?.title?.trim() || metadata.common.title?.trim() || baseName,
        artist: overrides[id]?.artist?.trim() || metadata.common.artist?.trim() || "Unknown artist",
        album: metadata.common.album?.trim() || "",
        duration,
        bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
        format: metadata.format.container || path.extname(absoluteFile).slice(1).toUpperCase(),
      };

      this.cache.set(cacheKey, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        track: {
          ...track,
          // Store base title/artist without overrides so overrides can reapply
          title: metadata.common.title?.trim() || baseName,
          artist: metadata.common.artist?.trim() || "Unknown artist",
        },
        absolutePath: absoluteFile,
      });

      return track;
    } catch (error) {
      console.warn(`Skipping unreadable audio file ${absoluteFile}:`, error);
      return null;
    }
  }

  async list(): Promise<Track[]> {
    await this.ensureSettings();
    if (!this.dirty && this.cachedList.length) return this.cachedList;
    if (this.listInflight) return this.listInflight;

    this.listInflight = (async () => {
      await fs.mkdir(this.musicDirectory, {recursive: true});
      const overrides = await this.readOverrides();
      const sources = this.sources();
      const jobs: Array<{source: SourceRoot; file: string}> = [];

      for (const source of sources) {
        const files = (await walk(source.absolutePath))
          .filter((file) => AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()));
        for (const file of files) jobs.push({source, file});
      }

      const tracks = (await mapPool(jobs, PARSE_CONCURRENCY, ({source, file}) =>
        this.buildTrack(source, file, overrides),
      )).filter((track): track is Track => track !== null);

      // Prune cache for files that disappeared
      const live = new Set(jobs.map((job) => job.file.toLowerCase()));
      for (const key of this.cache.keys()) {
        if (!live.has(key)) this.cache.delete(key);
      }

      tracks.sort((a, b) => a.title.localeCompare(b.title));
      this.cachedList = tracks;
      this.dirty = false;
      return tracks;
    })();

    try {
      return await this.listInflight;
    } finally {
      this.listInflight = null;
    }
  }

  async get(id: string): Promise<Track | undefined> {
    return (await this.list()).find((track) => track.id === id);
  }

  absolutePath(track: Track) {
    const source = this.sources().find((item) => item.id === (track.sourceId || "music"));
    if (!source) {
      // Fallback: try cache
      for (const entry of this.cache.values()) {
        if (entry.track.id === track.id) return entry.absolutePath;
      }
      return path.resolve(this.musicDirectory, track.relativePath);
    }
    const resolved = path.resolve(source.absolutePath, track.relativePath);
    if (!resolved.toLowerCase().startsWith(source.absolutePath.toLowerCase() + path.sep)
      && resolved.toLowerCase() !== source.absolutePath.toLowerCase()) {
      throw new Error("Invalid track path");
    }
    return resolved;
  }

  resolveMedia(sourceId: string, relativeParts: string[]) {
    const source = this.sources().find((item) => item.id === sourceId);
    if (!source) return null;
    const relativePath = relativeParts.join("/");
    const resolved = path.resolve(source.absolutePath, relativePath);
    const root = source.absolutePath.toLowerCase();
    const target = resolved.toLowerCase();
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return resolved;
  }

  async cover(track: Track) {
    const metadata = await parseFile(this.absolutePath(track), {duration: false, skipCovers: false});
    const picture = metadata.common.picture?.[0];
    return picture ? {data: picture.data, mime: picture.format || "image/jpeg"} : null;
  }

  async waveform(track: Track, points = 180) {
    const audioPath = this.absolutePath(track);
    const stat = await fs.stat(audioPath);
    const cacheDirectory = path.join(this.stateDirectory, "waveforms");
    const cachePath = path.join(cacheDirectory, `${track.id}-${Math.round(stat.mtimeMs)}-${points}-rms.json`);
    try {
      return JSON.parse(await fs.readFile(cachePath, "utf8")) as number[];
    } catch {
      // Generate the compact waveform once, then reuse it for subsequent visits.
    }
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-v", "error", "-i", audioPath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "1200", "-f", "f32le", "pipe:1"], {windowsHide: true});
      const chunks: Buffer[] = [];
      let error = "";
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error.trim() || `ffmpeg exited with ${code}`)));
    });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
    const rms = Array.from({length: points}, (_, index) => {
      const start = Math.floor((index / points) * samples.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / points) * samples.length));
      let sum = 0;
      for (let sample = start; sample < end; sample += 1) {
        const value = samples[sample] || 0;
        sum += value * value;
      }
      return Math.sqrt(sum / (end - start));
    });
    const sorted = [...rms].sort((a, b) => a - b);
    const ceiling = Math.max(1e-6, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))] || 1e-6);
    const waveform = rms.map((value) => Number(Math.min(1, value / ceiling).toFixed(4)));
    await fs.mkdir(cacheDirectory, {recursive: true});
    await fs.writeFile(cachePath, JSON.stringify(waveform), "utf8");
    return waveform;
  }

  async update(id: string, update: Override): Promise<Track | undefined> {
    const track = await this.get(id);
    if (!track) return undefined;
    const overrides = await this.readOverrides();
    overrides[id] = {
      title: update.title?.trim() || track.title,
      artist: update.artist?.trim() || track.artist,
    };
    await fs.mkdir(this.stateDirectory, {recursive: true});
    await fs.writeFile(this.overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
    this.dirty = true;
    return this.get(id);
  }

  /**
   * Remove a track from the library.
   * - deleteFile false: soft-hide only (file stays on disk)
   * - deleteFile true: unlink file; always hide as well so a failed delete still leaves the UI
   */
  async remove(id: string, options: {deleteFile?: boolean} = {}): Promise<boolean> {
    await this.ensureSettings();
    const track = await this.get(id);
    if (!track) return false;
    const deleteFile = options.deleteFile === true;

    if (deleteFile) {
      try {
        await fs.unlink(this.absolutePath(track));
      } catch (error) {
        console.warn(`Could not delete ${track.relativePath}:`, error);
      }
    }

    // Always hide so playlist removal works and disk-delete failure still drops it from the UI.
    if (!this.settings.hidden.includes(id)) {
      this.settings.hidden.push(id);
      await this.writeSettings();
    }

    const overrides = await this.readOverrides();
    if (overrides[id]) {
      delete overrides[id];
      await fs.writeFile(this.overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
    }

    for (const [key, entry] of this.cache) {
      if (entry.track.id === id) this.cache.delete(key);
    }
    this.markDirty();
    await this.list();
    return true;
  }

  /** After multer import, unhide matching music-root basenames and rescan. */
  async noteImportedFiles(fileNames: string[]) {
    await this.ensureSettings();
    if (fileNames.length && this.settings.hidden.length) {
      const importedIds = new Set(fileNames.map((name) => idFor("music", name)));
      this.settings.hidden = this.settings.hidden.filter((id) => !importedIds.has(id));
      await this.writeSettings();
    }
    this.markDirty();
  }

  /**
   * Clone audio files from an arbitrary folder into the shared music library.
   * maxDepth 0 = only direct children; 1 = one nested level; etc.
   * Returns how many files were copied (originals are never modified).
   */
  async importFolderCopy(folderPath: string, maxDepth = 0): Promise<{imported: string[]; skipped: number}> {
    const absolute = path.resolve(folderPath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a folder: ${folderPath}`);

    const libraryRoot = path.resolve(this.musicDirectory);
    if (absolute.toLowerCase() === libraryRoot.toLowerCase()
      || absolute.toLowerCase().startsWith(`${libraryRoot.toLowerCase()}${path.sep}`)) {
      throw new Error("That folder is already inside the shared music library — no copy needed.");
    }

    await fs.mkdir(this.musicDirectory, {recursive: true});
    const found = await collectAudioFiles(absolute, maxDepth);
    const imported: string[] = [];
    let skipped = 0;

    for (const source of found) {
      const base = path.basename(source).replace(/[^\p{L}\p{N}._ -]+/gu, "-") || `audio-${Date.now()}.mp3`;
      let destName = base;
      let dest = path.join(this.musicDirectory, destName);
      // If name exists, only skip when same size (already imported); else uniquify.
      const existing = await fs.stat(dest).catch(() => null);
      if (existing?.isFile()) {
        const srcStat = await fs.stat(source);
        if (existing.size === srcStat.size) {
          skipped += 1;
          continue;
        }
        const ext = path.extname(base);
        const stem = path.basename(base, ext);
        destName = `${stem}-${Date.now().toString(36)}${ext}`;
        dest = path.join(this.musicDirectory, destName);
      }
      await fs.copyFile(source, dest);
      imported.push(destName);
    }

    if (imported.length) await this.noteImportedFiles(imported);
    else this.markDirty();
    return {imported, skipped};
  }

  getRoot() {
    return this.root;
  }

  dispose() {
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}

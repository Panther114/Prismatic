/**
 * Shared library paths for local web (`pnpm dev` / `pnpm start`) and Electron.
 *
 * Default root (Windows): %USERPROFILE%\Music\Prismatic
 * Layout:
 *   Music/Prismatic/          ← audio files (and subfolders)
 *   Music/Prismatic/.prismatic/  ← playlists, settings, overrides
 *   Music/Prismatic/output/     ← optional export dumps
 *
 * Override with PRISMATIC_DATA_DIR and/or PRISMATIC_MUSIC_DIR.
 */
import path from "node:path";
import {promises as fs} from "node:fs";
import {createReadStream, createWriteStream} from "node:fs";
import {pipeline} from "node:stream/promises";

const SKIP_DIR_NAMES = new Set(["output", "node_modules", "dist", "release"]);

export function homeDirectory(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

/** Shared Prismatic library root used by web + desktop. */
export function defaultSharedRoot(): string {
  return path.join(homeDirectory(), "Music", "Prismatic");
}

export type LibraryPaths = {
  /** Parent folder for music + .prismatic + output */
  dataRoot: string;
  /** Folder scanned for audio (defaults to dataRoot itself) */
  musicDirectory: string;
  stateDirectory: string;
  outputDirectory: string;
};

export function resolveLibraryPaths(projectRoot: string): LibraryPaths {
  const dataRoot = process.env.PRISMATIC_DATA_DIR
    ? path.resolve(process.env.PRISMATIC_DATA_DIR)
    : defaultSharedRoot();

  // Music lives in the shared root (not nested under a second "music" folder),
  // unless PRISMATIC_MUSIC_DIR points elsewhere.
  const musicDirectory = process.env.PRISMATIC_MUSIC_DIR
    ? path.resolve(process.env.PRISMATIC_MUSIC_DIR)
    : dataRoot;

  const stateDirectory = path.join(dataRoot, ".prismatic");
  const outputDirectory = path.join(dataRoot, "output");

  void projectRoot;
  return {dataRoot, musicDirectory, stateDirectory, outputDirectory};
}

/** Directories the music walker must not enter. */
export function shouldSkipLibraryDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

async function countAudioFiles(directory: string, depth = 0): Promise<number> {
  if (depth > 4) return 0;
  let entries;
  try {
    entries = await fs.readdir(directory, {withFileTypes: true});
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (shouldSkipLibraryDir(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countAudioFiles(full, depth + 1);
    } else if (/\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(entry.name)) {
      count += 1;
    }
  }
  return count;
}

async function copyFile(src: string, dest: string) {
  await fs.mkdir(path.dirname(dest), {recursive: true});
  await pipeline(createReadStream(src), createWriteStream(dest));
}

async function copyDirAudio(srcDir: string, destDir: string, depth = 0): Promise<number> {
  if (depth > 6) return 0;
  let entries;
  try {
    entries = await fs.readdir(srcDir, {withFileTypes: true});
  } catch {
    return 0;
  }
  let copied = 0;
  for (const entry of entries) {
    if (shouldSkipLibraryDir(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += await copyDirAudio(from, to, depth + 1);
    } else if (/\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(entry.name)) {
      try {
        await fs.access(to);
      } catch {
        await copyFile(from, to);
        copied += 1;
      }
    }
  }
  return copied;
}

/**
 * One-time seed: if the shared library is empty, copy project `music/` samples
 * and migrate project `.prismatic` state when present.
 */
export async function migrateProjectLibraryToShared(
  projectRoot: string,
  paths: LibraryPaths,
): Promise<{seededMusic: number; migratedState: boolean}> {
  await Promise.all([
    fs.mkdir(paths.musicDirectory, {recursive: true}),
    fs.mkdir(paths.stateDirectory, {recursive: true}),
    fs.mkdir(paths.outputDirectory, {recursive: true}),
  ]);

  let seededMusic = 0;
  const projectMusic = path.join(projectRoot, "music");
  const sharedEmpty = (await countAudioFiles(paths.musicDirectory)) === 0;
  if (sharedEmpty) {
    seededMusic = await copyDirAudio(projectMusic, paths.musicDirectory);
  }

  let migratedState = false;
  const projectState = path.join(projectRoot, ".prismatic");
  try {
    const sharedFiles = await fs.readdir(paths.stateDirectory);
    const projectFiles = await fs.readdir(projectState).catch(() => [] as string[]);
    if (sharedFiles.length === 0 && projectFiles.length > 0) {
      for (const name of projectFiles) {
        if (name.startsWith(".")) continue;
        const from = path.join(projectState, name);
        const to = path.join(paths.stateDirectory, name);
        const stat = await fs.stat(from).catch(() => null);
        if (!stat?.isFile()) continue;
        await copyFile(from, to);
        migratedState = true;
      }
    }
  } catch {
    // no project state
  }

  return {seededMusic, migratedState};
}

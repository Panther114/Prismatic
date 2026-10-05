import {promises as fs} from "node:fs";
import path from "node:path";

export type ServerPlayerPrefs = {
  schemaVersion: 3;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  volume: number;
  muted: boolean;
  playbackRate: number;
  visualizerQuality: "low" | "high";
  resumeBehavior: "track" | "position";
  libraryMode: "songs" | "albums" | "artists";
  librarySort: "title" | "artist" | "album" | "bitrate" | "duration";
  compactPlayer: boolean;
};

const defaults: ServerPlayerPrefs = {
  schemaVersion: 3,
  shuffle: false,
  repeat: "off",
  volume: 0.86,
  muted: false,
  playbackRate: 1,
  visualizerQuality: "low",
  resumeBehavior: "position",
  libraryMode: "songs",
  librarySort: "title",
  compactPlayer: false,
};

function normalizeRate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(2, Math.max(0.5, value)) * 20) / 20;
}

function normalize(
  raw: Partial<Omit<ServerPlayerPrefs, "schemaVersion">> & {schemaVersion?: number},
  fallback: ServerPlayerPrefs,
): ServerPlayerPrefs {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], current: T): T =>
    allowed.includes(value as T) ? (value as T) : current;
  // Pre-v3 files only ever held the "track" default, which was never a choice.
  const legacy = !raw.schemaVersion || raw.schemaVersion < 3;
  return {
    schemaVersion: 3,
    shuffle: raw.shuffle !== undefined ? Boolean(raw.shuffle) : fallback.shuffle,
    repeat: pick(raw.repeat, ["off", "all", "one"], fallback.repeat),
    volume: typeof raw.volume === "number" && Number.isFinite(raw.volume)
      ? Math.min(1, Math.max(0, raw.volume))
      : fallback.volume,
    muted: raw.muted !== undefined ? Boolean(raw.muted) : fallback.muted,
    playbackRate: normalizeRate(raw.playbackRate, fallback.playbackRate),
    visualizerQuality: pick(raw.visualizerQuality, ["low", "high"], fallback.visualizerQuality),
    resumeBehavior: legacy ? "position" : pick(raw.resumeBehavior, ["track", "position"], fallback.resumeBehavior),
    libraryMode: pick(raw.libraryMode, ["songs", "albums", "artists"], fallback.libraryMode),
    librarySort: pick(raw.librarySort, ["title", "artist", "album", "bitrate", "duration"], fallback.librarySort),
    compactPlayer: raw.compactPlayer !== undefined ? Boolean(raw.compactPlayer) : fallback.compactPlayer,
  };
}

export class PlayerPrefsRepository {
  constructor(private readonly stateDirectory: string) {}

  private get filePath() {
    return path.join(this.stateDirectory, "player.json");
  }

  async read(): Promise<ServerPlayerPrefs> {
    try {
      return normalize(JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<ServerPlayerPrefs>, defaults);
    } catch {
      return {...defaults};
    }
  }

  async write(prefs: Partial<ServerPlayerPrefs>): Promise<ServerPlayerPrefs> {
    const next = normalize({...prefs, schemaVersion: 3}, await this.read());
    await fs.mkdir(this.stateDirectory, {recursive: true});
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.filePath);
    return next;
  }
}

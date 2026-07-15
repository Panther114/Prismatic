import {promises as fs} from "node:fs";
import path from "node:path";

export type ServerPlayerPrefs = {
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  volume: number;
  muted: boolean;
};

const defaults: ServerPlayerPrefs = {
  shuffle: false,
  repeat: "off",
  volume: 0.86,
  muted: false,
};

export class PlayerPrefsRepository {
  constructor(private readonly stateDirectory: string) {}

  private get filePath() {
    return path.join(this.stateDirectory, "player.json");
  }

  async read(): Promise<ServerPlayerPrefs> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<ServerPlayerPrefs>;
      const volume = typeof raw.volume === "number" && Number.isFinite(raw.volume)
        ? Math.min(1, Math.max(0, raw.volume))
        : defaults.volume;
      const repeat = raw.repeat === "all" || raw.repeat === "one" || raw.repeat === "off" ? raw.repeat : defaults.repeat;
      return {
        shuffle: Boolean(raw.shuffle),
        repeat,
        volume,
        muted: Boolean(raw.muted),
      };
    } catch {
      return {...defaults};
    }
  }

  async write(prefs: Partial<ServerPlayerPrefs>): Promise<ServerPlayerPrefs> {
    const current = await this.read();
    const next: ServerPlayerPrefs = {
      shuffle: prefs.shuffle !== undefined ? Boolean(prefs.shuffle) : current.shuffle,
      repeat: prefs.repeat === "all" || prefs.repeat === "one" || prefs.repeat === "off" ? prefs.repeat : current.repeat,
      volume: typeof prefs.volume === "number" && Number.isFinite(prefs.volume)
        ? Math.min(1, Math.max(0, prefs.volume))
        : current.volume,
      muted: prefs.muted !== undefined ? Boolean(prefs.muted) : current.muted,
    };
    await fs.mkdir(this.stateDirectory, {recursive: true});
    await fs.writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}

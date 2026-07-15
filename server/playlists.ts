import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash, randomBytes} from "node:crypto";

export type Playlist = {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return createHash("sha1").update(randomBytes(16)).digest("hex").slice(0, 12);
}

export class PlaylistRepository {
  private cache: Playlist[] | null = null;

  constructor(private readonly stateDirectory: string) {}

  private get filePath() {
    return path.join(this.stateDirectory, "playlists.json");
  }

  private async read(): Promise<Playlist[]> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Playlist[];
      this.cache = Array.isArray(raw)
        ? raw.filter((p) => p && typeof p.id === "string" && Array.isArray(p.trackIds))
        : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async write(list: Playlist[]) {
    this.cache = list;
    await fs.mkdir(this.stateDirectory, {recursive: true});
    await fs.writeFile(this.filePath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  }

  async list() {
    return [...(await this.read())];
  }

  async create(input: {name: string; trackIds?: string[]}) {
    const list = await this.read();
    const playlist: Playlist = {
      id: `pl-${newId()}`,
      name: (input.name || "New playlist").trim() || "New playlist",
      trackIds: Array.isArray(input.trackIds) ? input.trackIds.map(String) : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.write([...list, playlist]);
    return playlist;
  }

  async update(id: string, patch: {name?: string; trackIds?: string[]}) {
    const list = await this.read();
    const index = list.findIndex((p) => p.id === id);
    if (index < 0) return null;
    const current = list[index];
    const updated: Playlist = {
      ...current,
      name: patch.name !== undefined ? (String(patch.name).trim() || current.name) : current.name,
      trackIds: patch.trackIds !== undefined ? patch.trackIds.map(String) : current.trackIds,
      updatedAt: nowIso(),
    };
    const next = [...list];
    next[index] = updated;
    await this.write(next);
    return updated;
  }

  async remove(id: string) {
    const list = await this.read();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return null;
    await this.write(next);
    return next;
  }

  async stripTrack(trackId: string) {
    const list = await this.read();
    let changed = false;
    const next = list.map((p) => {
      if (!p.trackIds.includes(trackId)) return p;
      changed = true;
      return {...p, trackIds: p.trackIds.filter((t) => t !== trackId), updatedAt: nowIso()};
    });
    if (changed) await this.write(next);
    return next;
  }
}

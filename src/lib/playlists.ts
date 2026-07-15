import type {Playlist} from "../types";
import {api} from "../api";

const STORAGE_KEY = "prismatic.playlists";

function randomId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 10) || `pl${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function readLocal(): Playlist[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Playlist[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.trackIds));
  } catch {
    return [];
  }
}

function writeLocal(list: Playlist[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export class PlaylistStore {
  private mode: "local" | "cloud" = "cloud";
  private cache: Playlist[] = [];

  setMode(mode: "local" | "cloud") {
    this.mode = mode;
  }

  list() {
    return [...this.cache];
  }

  get(id: string) {
    return this.cache.find((p) => p.id === id) || null;
  }

  /**
   * Local/desktop: disk is source of truth (Music/Prismatic/.prismatic/playlists.json).
   * One-time: migrate any browser localStorage playlists onto disk if disk is empty.
   */
  async load() {
    if (this.mode === "local") {
      try {
        let disk = await api.playlists();
        const browser = readLocal();
        if (disk.length === 0 && browser.length > 0) {
          for (const pl of browser) {
            try {
              await api.createPlaylist({name: pl.name, trackIds: pl.trackIds});
            } catch {
              // ignore individual failures
            }
          }
          disk = await api.playlists();
          // Clear origin-local copy so we don't re-migrate forever
          writeLocal([]);
        }
        this.cache = disk;
        return this.list();
      } catch {
        // Fall through to localStorage only if API is down
      }
    }
    this.cache = readLocal();
    return this.list();
  }

  async create(name: string, trackIds: string[] = []) {
    const trimmed = name.trim() || "New playlist";
    if (this.mode === "local") {
      try {
        const created = await api.createPlaylist({name: trimmed, trackIds});
        this.cache = await api.playlists();
        return created;
      } catch {
        // local fallback
      }
    }
    const playlist: Playlist = {
      id: `pl-${randomId()}`,
      name: trimmed,
      trackIds: [...trackIds],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.cache = [...this.cache, playlist];
    writeLocal(this.cache);
    return playlist;
  }

  async update(id: string, patch: {name?: string; trackIds?: string[]}) {
    if (this.mode === "local") {
      try {
        const updated = await api.updatePlaylist(id, patch);
        this.cache = await api.playlists();
        return updated;
      } catch {
        // local fallback
      }
    }
    const existing = this.cache.find((p) => p.id === id);
    if (!existing) return null;
    const updated: Playlist = {
      ...existing,
      name: patch.name !== undefined ? (patch.name.trim() || existing.name) : existing.name,
      trackIds: patch.trackIds !== undefined ? [...patch.trackIds] : existing.trackIds,
      updatedAt: nowIso(),
    };
    this.cache = this.cache.map((p) => (p.id === id ? updated : p));
    writeLocal(this.cache);
    return updated;
  }

  async remove(id: string) {
    if (this.mode === "local") {
      try {
        this.cache = await api.deletePlaylist(id);
        return this.list();
      } catch {
        // local fallback
      }
    }
    this.cache = this.cache.filter((p) => p.id !== id);
    writeLocal(this.cache);
    return this.list();
  }

  async stripTrack(trackId: string) {
    const previous = this.cache;
    const next = previous.map((p) => {
      if (!p.trackIds.includes(trackId)) return p;
      return {...p, trackIds: p.trackIds.filter((id) => id !== trackId), updatedAt: nowIso()};
    });
    const changed = next.some((p, i) => p.trackIds.length !== previous[i].trackIds.length);
    if (!changed) return this.list();
    this.cache = next;
    if (this.mode === "local") {
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].trackIds.length === previous[i].trackIds.length) continue;
        try {
          await api.updatePlaylist(next[i].id, {trackIds: next[i].trackIds});
        } catch {
          writeLocal(this.cache);
          return this.list();
        }
      }
      try {
        this.cache = await api.playlists();
      } catch {
        writeLocal(this.cache);
      }
    } else {
      writeLocal(this.cache);
    }
    return this.list();
  }
}

export const playlistStore = new PlaylistStore();

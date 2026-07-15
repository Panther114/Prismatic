import type {Track} from "../types";
import {idbDeleteTrack, idbListTracks, idbPutTrack, type StoredClientTrack} from "./clientIdb";

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;

function randomId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 10) || `t${Date.now().toString(36)}`;
}

function baseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

async function decodeDurationAndWaveform(file: Blob): Promise<{duration: number; waveform: number[]}> {
  const context = new AudioContext();
  try {
    const buffer = await file.arrayBuffer();
    const audio = await context.decodeAudioData(buffer.slice(0));
    const duration = audio.duration || 0;
    const channel = audio.getChannelData(0);
    const buckets = 240;
    const block = Math.max(1, Math.floor(channel.length / buckets));
    const waveform: number[] = [];
    for (let i = 0; i < buckets; i += 1) {
      const start = i * block;
      let peak = 0;
      for (let j = 0; j < block && start + j < channel.length; j += 1) {
        const v = Math.abs(channel[start + j]);
        if (v > peak) peak = v;
      }
      waveform.push(Math.min(1, peak * 1.6));
    }
    return {duration, waveform};
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function tryCoverBlob(file: File): Promise<{url: string; buffer?: ArrayBuffer; type?: string}> {
  try {
    const {parseBlob} = await import("music-metadata");
    const meta = await parseBlob(file);
    const pic = meta.common.picture?.[0];
    if (!pic?.data) return {url: "/music-note.png"};
    const bytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayBuffer);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const type = pic.format || "image/jpeg";
    const blob = new Blob([copy], {type});
    return {url: URL.createObjectURL(blob), buffer: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength), type};
  } catch {
    return {url: "/music-note.png"};
  }
}

export type ClientTrackExtras = {
  file: File;
  waveform: number[];
  objectUrls: string[];
};

/** In-browser track store for cloud / client-only mode (no server disk). */
export class ClientLibrary {
  private tracks: Track[] = [];
  private extras = new Map<string, ClientTrackExtras>();
  private hydrated = false;

  list() {
    return [...this.tracks];
  }

  getExtras(id: string) {
    return this.extras.get(id);
  }

  waveform(id: string) {
    return this.extras.get(id)?.waveform || [];
  }

  /** Restore tracks from IndexedDB (cloud offline). */
  async hydrate() {
    if (this.hydrated) return this.list();
    this.hydrated = true;
    if (typeof indexedDB === "undefined") return this.list();
    try {
      const stored = await idbListTracks();
      for (const row of stored) {
        if (this.tracks.some((t) => t.id === row.id)) continue;
        const audioBlob = new Blob([row.audio], {type: row.audioType || "audio/mpeg"});
        const file = new File([audioBlob], row.fileName, {type: row.audioType || "audio/mpeg"});
        const mediaUrl = URL.createObjectURL(audioBlob);
        let coverUrl = "/music-note.png";
        const objectUrls = [mediaUrl];
        if (row.cover && row.cover.byteLength) {
          const coverBlob = new Blob([row.cover], {type: row.coverType || "image/jpeg"});
          coverUrl = URL.createObjectURL(coverBlob);
          objectUrls.push(coverUrl);
        }
        const track: Track = {
          id: row.id,
          sourceId: "browser",
          fileName: row.fileName,
          relativePath: row.fileName,
          folder: "Browser",
          mediaUrl,
          coverUrl,
          waveformUrl: `client-waveform:${row.id}`,
          title: row.title,
          artist: row.artist,
          album: row.album,
          duration: row.duration,
          bitrate: null,
          format: row.format,
          clientOnly: true,
        };
        this.tracks.push(track);
        this.extras.set(row.id, {file, waveform: row.waveform || [], objectUrls});
      }
    } catch (error) {
      console.warn("Client library hydrate failed", error);
    }
    return this.list();
  }

  private async persist(id: string) {
    const track = this.tracks.find((t) => t.id === id);
    const extras = this.extras.get(id);
    if (!track || !extras) return;
    try {
      const audio = await extras.file.arrayBuffer();
      let cover: ArrayBuffer | undefined;
      let coverType: string | undefined;
      if (track.coverUrl.startsWith("blob:")) {
        try {
          const res = await fetch(track.coverUrl);
          const blob = await res.blob();
          cover = await blob.arrayBuffer();
          coverType = blob.type || "image/jpeg";
        } catch {
          // ignore cover
        }
      }
      const record: StoredClientTrack = {
        id: track.id,
        fileName: track.fileName,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        format: track.format,
        waveform: extras.waveform,
        audio,
        audioType: extras.file.type || "audio/mpeg",
        cover,
        coverType,
      };
      await idbPutTrack(record);
    } catch (error) {
      console.warn("Client library persist failed", error);
    }
  }

  async importFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((file) => AUDIO_EXT.test(file.name) || file.type.startsWith("audio/"));
    if (!list.length) throw new Error("No supported audio files selected");

    for (const file of list) {
      const {duration, waveform} = await decodeDurationAndWaveform(file);
      const mediaUrl = URL.createObjectURL(file);
      const cover = await tryCoverBlob(file);
      const objectUrls = cover.url.startsWith("blob:") ? [mediaUrl, cover.url] : [mediaUrl];
      let title = baseName(file.name);
      let artist = "Unknown Artist";
      let album = "";
      try {
        const {parseBlob} = await import("music-metadata");
        const meta = await parseBlob(file);
        title = meta.common.title || title;
        artist = meta.common.artist || artist;
        album = meta.common.album || "";
      } catch {
        // Filename fallback is fine.
      }
      const id = `local-${randomId()}`;
      const track: Track = {
        id,
        sourceId: "browser",
        fileName: file.name,
        relativePath: file.name,
        folder: "Browser",
        mediaUrl,
        coverUrl: cover.url,
        waveformUrl: `client-waveform:${id}`,
        title,
        artist,
        album,
        duration,
        bitrate: null,
        format: (file.name.split(".").pop() || "audio").toUpperCase(),
        clientOnly: true,
      };
      this.tracks.push(track);
      this.extras.set(id, {file, waveform, objectUrls});
      void this.persist(id);
    }
    return this.list();
  }

  update(id: string, update: {title: string; artist: string}) {
    const track = this.tracks.find((item) => item.id === id);
    if (!track) return null;
    track.title = update.title.trim() || track.title;
    track.artist = update.artist.trim() || track.artist;
    void this.persist(id);
    return {...track};
  }

  remove(id: string) {
    const extras = this.extras.get(id);
    if (extras) {
      for (const url of extras.objectUrls) URL.revokeObjectURL(url);
      this.extras.delete(id);
    }
    this.tracks = this.tracks.filter((track) => track.id !== id);
    void idbDeleteTrack(id).catch(() => undefined);
    return this.list();
  }
}

export const clientLibrary = new ClientLibrary();

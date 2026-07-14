import type {Track} from "../types";

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

async function tryCoverUrl(file: File): Promise<string> {
  try {
    const {parseBlob} = await import("music-metadata");
    const meta = await parseBlob(file);
    const pic = meta.common.picture?.[0];
    if (!pic?.data) return "/music-note.png";
    const bytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayBuffer);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], {type: pic.format || "image/jpeg"});
    return URL.createObjectURL(blob);
  } catch {
    return "/music-note.png";
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

  list() {
    return [...this.tracks];
  }

  getExtras(id: string) {
    return this.extras.get(id);
  }

  waveform(id: string) {
    return this.extras.get(id)?.waveform || [];
  }

  async importFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((file) => AUDIO_EXT.test(file.name) || file.type.startsWith("audio/"));
    if (!list.length) throw new Error("No supported audio files selected");

    for (const file of list) {
      const {duration, waveform} = await decodeDurationAndWaveform(file);
      const mediaUrl = URL.createObjectURL(file);
      const coverUrl = await tryCoverUrl(file);
      const objectUrls = coverUrl.startsWith("blob:") ? [mediaUrl, coverUrl] : [mediaUrl];
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
        coverUrl,
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
    }
    return this.list();
  }

  update(id: string, update: {title: string; artist: string}) {
    const track = this.tracks.find((item) => item.id === id);
    if (!track) return null;
    track.title = update.title.trim() || track.title;
    track.artist = update.artist.trim() || track.artist;
    return {...track};
  }

  remove(id: string) {
    const extras = this.extras.get(id);
    if (extras) {
      for (const url of extras.objectUrls) URL.revokeObjectURL(url);
      this.extras.delete(id);
    }
    this.tracks = this.tracks.filter((track) => track.id !== id);
    return this.list();
  }
}

export const clientLibrary = new ClientLibrary();

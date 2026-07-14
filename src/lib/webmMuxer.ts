/**
 * Minimal WebM (EBML) muxer for WebCodecs EncodedVideoChunk + EncodedAudioChunk.
 * Enough for Prismatic offline exports (VP8/VP9 + Opus).
 */

type TrackKind = "video" | "audio";

type CuePoint = {timeNs: number; clusterOffset: number};

function writeVint(value: number): Uint8Array {
  if (value < 0x7f) return new Uint8Array([value | 0x80]);
  if (value < 0x3fff) return new Uint8Array([(value >> 8) | 0x40, value & 0xff]);
  if (value < 0x1fffff) return new Uint8Array([(value >> 16) | 0x20, (value >> 8) & 0xff, value & 0xff]);
  return new Uint8Array([(value >> 24) | 0x10, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function writeUInt(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = value & 0xff;
    value >>= 8;
  }
  return out;
}

function writeFloat64(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  return new Uint8Array(buf);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ebml(id: number[], data: Uint8Array): Uint8Array {
  return concat([new Uint8Array(id), writeVint(data.length), data]);
}

function ebmlMulti(id: number[], children: Uint8Array[]): Uint8Array {
  return ebml(id, concat(children));
}

function ebmlUint(id: number[], value: number, bytes = 1): Uint8Array {
  return ebml(id, writeUInt(value, bytes));
}

function ebmlFloat(id: number[], value: number): Uint8Array {
  return ebml(id, writeFloat64(value));
}

function ebmlString(id: number[], value: string): Uint8Array {
  return ebml(id, new TextEncoder().encode(value));
}

export type WebmMuxerOptions = {
  width: number;
  height: number;
  frameRate: number;
  videoCodec: "V_VP9" | "V_VP8";
  sampleRate: number;
  audioChannels: number;
  hasAudio: boolean;
};

export class WebmMuxer {
  private readonly opts: WebmMuxerOptions;
  private readonly chunks: Uint8Array[] = [];
  private clusterParts: Uint8Array[] = [];
  private clusterStartNs = 0;
  private clusterOpen = false;
  private size = 0;
  private cues: CuePoint[] = [];
  private headerWritten = false;
  private durationNs = 0;
  private segmentOffset = 0;

  constructor(opts: WebmMuxerOptions) {
    this.opts = opts;
  }

  private push(part: Uint8Array) {
    this.chunks.push(part);
    this.size += part.length;
  }

  private ensureHeader() {
    if (this.headerWritten) return;
    this.headerWritten = true;

    const ebmlHeader = ebmlMulti([0x1a, 0x45, 0xdf, 0xa3], [
      ebmlUint([0x42, 0x86], 1), // EBMLVersion
      ebmlUint([0x42, 0xf7], 1), // EBMLReadVersion
      ebmlUint([0x42, 0xf2], 4), // EBMLMaxIDLength
      ebmlUint([0x42, 0xf3], 8), // EBMLMaxSizeLength
      ebmlString([0x42, 0x82], "webm"), // DocType
      ebmlUint([0x42, 0x87], 4), // DocTypeVersion
      ebmlUint([0x42, 0x85], 2), // DocTypeReadVersion
    ]);
    this.push(ebmlHeader);

    // Segment with unknown size (live streaming style)
    this.push(new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    this.segmentOffset = this.size;

    const info = ebmlMulti([0x15, 0x49, 0xa9, 0x66], [
      ebmlUint([0x2a, 0xd7, 0xb1], 1_000_000, 3), // TimestampScale = 1ms
      ebmlString([0x4d, 0x80], "Prismatic"),
      ebmlString([0x57, 0x41], "Prismatic"),
      ebmlFloat([0x44, 0x89], 0), // Duration placeholder (ms float) — optional
    ]);
    this.push(info);

    const videoTrack = ebmlMulti([0xae], [
      ebmlUint([0xd7], 1), // TrackNumber
      ebmlUint([0x73, 0xc5], 1, 2), // TrackUID
      ebmlUint([0x83], 1), // TrackType video
      ebmlString([0x86], this.opts.videoCodec),
      ebmlUint([0x9c], 0), // FlagLacing
      ebmlString([0x22, 0xb5, 0x9c], "und"),
      ebmlMulti([0xe0], [
        ebmlUint([0xb0], this.opts.width, 2),
        ebmlUint([0xba], this.opts.height, 2),
      ]),
    ]);

    const tracks: Uint8Array[] = [videoTrack];
    if (this.opts.hasAudio) {
      tracks.push(ebmlMulti([0xae], [
        ebmlUint([0xd7], 2),
        ebmlUint([0x73, 0xc5], 2, 2),
        ebmlUint([0x83], 2), // audio
        ebmlString([0x86], "A_OPUS"),
        ebmlUint([0x9c], 0),
        ebmlString([0x22, 0xb5, 0x9c], "und"),
        ebmlUint([0x56, 0xaa], 3840, 2), // CodecDelay (ns/48k typical) simplified
        ebmlUint([0x56, 0xbb], 80_000_000, 4), // SeekPreRoll
        ebmlMulti([0xe1], [
          ebmlFloat([0xb5], this.opts.sampleRate),
          ebmlUint([0x9f], this.opts.audioChannels),
        ]),
        // OpusHead private data
        ebml([0x63, 0xa2], this.opusHead()),
      ]));
    }

    this.push(ebmlMulti([0x16, 0x54, 0xae, 0x6b], tracks));
  }

  private opusHead(): Uint8Array {
    // RFC 7845 OpusHead
    const channels = this.opts.audioChannels;
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // OpusHead
    head[8] = 1; // version
    head[9] = channels;
    head[10] = 0;
    head[11] = 0; // pre-skip LE
    const sr = this.opts.sampleRate;
    head[12] = sr & 0xff;
    head[13] = (sr >> 8) & 0xff;
    head[14] = (sr >> 16) & 0xff;
    head[15] = (sr >> 24) & 0xff;
    head[16] = 0;
    head[17] = 0; // output gain
    head[18] = 0; // channel mapping family
    return head;
  }

  private flushCluster() {
    if (!this.clusterOpen) return;
    const cluster = ebmlMulti([0x1f, 0x43, 0xb6, 0x75], [
      ebmlUint([0xe7], Math.round(this.clusterStartNs / 1_000_000), 4), // Timestamp ms
      ...this.clusterParts,
    ]);
    this.cues.push({timeNs: this.clusterStartNs, clusterOffset: this.size - this.segmentOffset});
    this.push(cluster);
    this.clusterParts = [];
    this.clusterOpen = false;
  }

  private ensureCluster(timeNs: number) {
    this.ensureHeader();
    // New cluster every ~2s or on first block
    if (!this.clusterOpen || timeNs - this.clusterStartNs > 2_000_000_000) {
      this.flushCluster();
      this.clusterStartNs = timeNs;
      this.clusterOpen = true;
    }
  }

  addVideoChunk(chunk: EncodedVideoChunk) {
    const timeNs = chunk.timestamp * 1000; // VideoFrame timestamp is µs
    this.durationNs = Math.max(this.durationNs, timeNs + (chunk.duration || 0) * 1000);
    this.ensureCluster(timeNs);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const relMs = Math.max(0, Math.round((timeNs - this.clusterStartNs) / 1_000_000));
    this.clusterParts.push(this.simpleBlock(1, relMs, data, chunk.type === "key"));
  }

  addAudioChunk(chunk: EncodedAudioChunk) {
    const timeNs = chunk.timestamp * 1000;
    this.durationNs = Math.max(this.durationNs, timeNs + (chunk.duration || 0) * 1000);
    this.ensureCluster(timeNs);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const relMs = Math.max(0, Math.round((timeNs - this.clusterStartNs) / 1_000_000));
    this.clusterParts.push(this.simpleBlock(2, relMs, data, true));
  }

  private simpleBlock(track: number, relMs: number, data: Uint8Array, keyframe: boolean): Uint8Array {
    // SimpleBlock: track | timecode | flags | data
    const trackVint = writeVint(track);
    const tc = writeUInt(relMs, 2);
    const flags = keyframe ? 0x80 : 0x00;
    return ebml([0xa3], concat([trackVint, tc, new Uint8Array([flags]), data]));
  }

  finalize(): Blob {
    this.flushCluster();
    return new Blob(this.chunks as BlobPart[], {type: "video/webm"});
  }
}

export type {TrackKind};

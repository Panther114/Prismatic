export type Track = {
  id: string;
  /** music = built-in library folder; otherwise a watched-folder id */
  sourceId: string;
  fileName: string;
  relativePath: string;
  folder: string;
  mediaUrl: string;
  coverUrl: string;
  waveformUrl: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  bitrate: number | null;
  format: string;
};

export type ResolutionPreset = "720p" | "1080p" | "4k" | "square" | "portrait";
export type RenderSettings = {
  resolution: ResolutionPreset;
  width: number;
  height: number;
  audioBitrate: 128 | 192 | 256 | 320;
};

export type RenderJob = {
  id: string;
  trackId: string;
  trackTitle: string;
  settings: RenderSettings;
  status: "queued" | "analyzing" | "rendering" | "complete" | "failed" | "cancelled";
  stage: string;
  progress: number;
  createdAt: string;
  outputs: Array<{fileName: string; url: string}>;
  error?: string;
  log: string[];
};

export type AudioAnalysis = {
  fps: number;
  duration: number;
  totalFrames: number;
  bands: number;
  frames: Array<{
    bands: number[];
    energy: number;
    bass: number;
    mid: number;
    treble: number;
    peak: number;
  }>;
};

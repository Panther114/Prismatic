export type Track = {
  id: string;
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
  /** Present when the track lives only in the browser (cloud / client mode). */
  clientOnly?: boolean;
};

export type WatchFolder = {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
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

export type SavedRender = {fileName: string; url: string};
/** play = listen + live visuals; studio = export + render history (former visualize+renders) */
export type View = "library" | "playlists" | "play" | "import" | "studio";

export type Playlist = {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type RepeatMode = "off" | "all" | "one";

export type PlayerPrefs = {
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
};

export type QueueSource =
  | {kind: "library"}
  | {kind: "playlist"; playlistId: string; name: string};

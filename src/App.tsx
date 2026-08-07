import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  ArrowRight, Check, Clapperboard, CloudUpload, FolderOpen, FolderPlus, Library,
  ListMusic, LoaderCircle, Menu, Music2, Play as PlayIcon, Plus, Save, Search, Settings, Shuffle, Square, Trash2, X,
} from "lucide-react";
import {api, isTauri} from "./api";
import {VisualizerCanvas, type VisualizerCanvasHandle} from "./components/VisualizerCanvas";
import {DiscPlayer} from "./components/DiscPlayer";
import {PlaylistView} from "./components/PlaylistView";
import {PlaylistCover} from "./components/PlaylistCover";
import {LibraryView} from "./components/LibraryView";
import {PersistentPlayer} from "./components/PersistentPlayer";
import {QueueDrawer} from "./components/QueueDrawer";
import {CustomSelect} from "./components/CustomSelect";
import {UpdateDialog} from "./components/UpdateDialog";
import {UpdateSettingsCard} from "./components/UpdateSettingsCard";
import {clientLibrary} from "./lib/clientLibrary";
import {exportClientVideo, exportPlaylistClientVideo} from "./lib/clientExport";
import {buildRenderSettings, playlistVisualsFileName, visualsFileName} from "./lib/resolutions";
import {playlistStore} from "./lib/playlists";
import {exportPlaylistZip, importPlaylistZip} from "./lib/playlistZip";
import {loadPlayerPrefs, loadPlayerPrefsLocal, savePlayerPrefs} from "./lib/playerPrefs";
import {
  createQueue,
  currentId,
  cycleRepeat,
  loadQueue,
  jumpTo,
  onTrackEnded,
  removeTrackFromQueue,
  reorderQueue,
  setRepeat,
  saveQueue,
  setShuffle,
  skipNext,
  skipPrev,
  type QueueState,
} from "./lib/playbackQueue";
import type {Playlist, RenderJob, ResolutionPreset, SavedRender, Track, View, WatchFolder} from "./types";
import type {LibraryMode, LibrarySort} from "./types";
import {setCompactPlayer} from "./lib/compactPlayer";
import {appUpdater} from "./lib/appUpdater";

const ACTIVE_STATUSES = new Set(["queued", "analyzing", "rendering"]);

/** Cap cached waveforms (LRU) — each track waveform stays in memory forever otherwise. */
const WAVEFORM_CACHE_LIMIT = 6;
function rememberWaveform(cache: Map<string, number[]>, id: string, wave: number[]) {
  cache.delete(id);
  cache.set(id, wave);
  while (cache.size > WAVEFORM_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function TrackCover({track}: {track: Track}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track.id]);
  return (
    <span className="track-cover" aria-hidden="true">
      {!failed
        ? <img className={track.coverUrl.includes("music-note.") ? "fallback-note" : ""} src={track.coverUrl} alt="" onError={() => setFailed(true)} />
        : <img className="fallback-note" src="/music-note.svg" alt="" />}
    </span>
  );
}

function StatusMark({job}: {job?: RenderJob}) {
  if (!job) return <span className="status-dot ready" />;
  if (job.status === "failed") return <span className="status-dot failed" />;
  if (job.status === "cancelled") return <span className="status-dot cancelled" />;
  if (job.status === "complete") return <span className="status-dot ready" />;
  return <LoaderCircle className="status-spinner" size={15} />;
}

export default function App() {
  const [view, setView] = useState<View>("library");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("songs");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("title");
  const [queueOpen, setQueueOpen] = useState(false);
  const [compactPlayer, setCompactPlayerState] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [savedRenders, setSavedRenders] = useState<SavedRender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cloudMode, setCloudMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [playlistCreateRequest, setPlaylistCreateRequest] = useState(0);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [resolution, setResolution] = useState<ResolutionPreset>("1080p");
  const [audioBitrate, setAudioBitrate] = useState<128 | 192 | 256 | 320>(320);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [folderDepth, setFolderDepth] = useState(0);
  const [folderPathInput, setFolderPathInput] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [cancellingId, setCancellingId] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [watchFolders, setWatchFolders] = useState<WatchFolder[]>([]);
  const [watchPath, setWatchPath] = useState("");
  const [watchBusy, setWatchBusy] = useState(false);
  const [musicDirectory, setMusicDirectory] = useState("");
  const [exportSize, setExportSize] = useState<{width: number; height: number} | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipStatus, setZipStatus] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<null | {
    mode: "simple";
    title: string;
    body: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm?: () => void | Promise<void>;
  }>(null);
  // Seed from localStorage only; disk prefs load once local mode is known.
  const initialPrefs = useMemo(() => loadPlayerPrefsLocal(), []);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [muted, setMuted] = useState(initialPrefs.muted);
  // Desktop/Tauri is always local; cloud only until health proves otherwise (or web cloud).
  const offlineModeRef = useRef<"local" | "cloud">(isTauri ? "local" : "cloud");
  const prefsReadyRef = useRef(false);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [queue, setQueue] = useState<QueueState>(() =>
    createQueue([], {shuffle: initialPrefs.shuffle, repeat: initialPrefs.repeat, sourceLabel: "Library"}),
  );
  const [autoplayNext, setAutoplayNext] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const recordDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const visualizerRef = useRef<VisualizerCanvasHandle>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const togglePlaybackRef = useRef<() => Promise<void>>(async () => undefined);
  const libraryGenerationRef = useRef(0);
  const cloudModeRef = useRef(false);
  const waveformCacheRef = useRef(new Map<string, number[]>());
  const lastVolumeRef = useRef(initialPrefs.volume || 0.86);
  const queueRef = useRef(queue);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);
  const playAfterLoadRef = useRef(false);

  queueRef.current = queue;
  const playerChromeVisible = view === "library" || view === "play" || view === "playlists";

  const selected = useMemo(() => tracks.find((track) => track.id === selectedId) || tracks[0], [tracks, selectedId]);
  const activeJob = useMemo(() => jobs.find((job) => job.trackId === selected?.id && ACTIVE_STATUSES.has(job.status)), [jobs, selected?.id]);
  const dirty = Boolean(selected && (title !== selected.title || artist !== selected.artist));
  const progress = selected?.duration ? Math.min(1, currentTime / selected.duration) : 0;
  const tracksById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  /**
   * Offline local/desktop: disk library is the only source of truth.
   * Cloud (Railway): merge browser IndexedDB imports.
   * Never mix browser-only blob tracks into local mode — they desync from Electron.
   */
  const mergeTracks = useCallback((serverTracks: Track[], modeCloud: boolean) => {
    if (!modeCloud) return [...serverTracks];
    const local = clientLibrary.list();
    const byId = new Map<string, Track>();
    for (const track of serverTracks) byId.set(track.id, track);
    for (const track of local) byId.set(track.id, track);
    return [...byId.values()];
  }, []);

  const refresh = useCallback(async () => {
    const health = await api.health().catch(() => null);
    // Desktop (Tauri) and local Node always offline-disk; never treat as cloud.
    let modeCloud = !isTauri && health?.mode === "cloud" && health?.desktop !== true;
    if (isTauri || health?.mode === "local" || health?.desktop === true) modeCloud = false;
    cloudModeRef.current = modeCloud;
    offlineModeRef.current = modeCloud ? "cloud" : "local";
    setCloudMode(modeCloud);

    // Only hydrate browser-only library in true cloud mode
    if (modeCloud) {
      await clientLibrary.hydrate().catch(() => undefined);
    }

    let serverTracks: Track[] = [];
    if (!modeCloud) {
      try {
        serverTracks = await api.tracks();
      } catch (cause) {
        // Desktop must stay on disk mode — surface the error instead of flipping to cloud.
        if (isTauri) {
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
        // Web local server down: fall back to browser IndexedDB only.
        modeCloud = true;
        cloudModeRef.current = true;
        offlineModeRef.current = "cloud";
        setCloudMode(true);
        await clientLibrary.hydrate().catch(() => undefined);
      }
    }
    playlistStore.setMode(modeCloud ? "cloud" : "local");
    const nextTracks = mergeTracks(serverTracks, modeCloud);
    setTracks(nextTracks);
    setSelectedId((current) => {
      if (current && nextTracks.some((track) => track.id === current)) return current;
      return nextTracks[0]?.id || "";
    });
    setQueue((q) => {
      if (q.order.length) return q;
      const fallback = createQueue(
        nextTracks.map((t) => t.id),
        {shuffle: q.shuffle, repeat: q.repeat, startId: nextTracks[0]?.id, sourceLabel: "Library"},
      );
      return loadQueue(nextTracks.map((track) => track.id), fallback);
    });

    // Shared offline prefs (disk) for local web + desktop — gate saves until this finishes.
    try {
      const prefs = await loadPlayerPrefs(modeCloud ? "cloud" : "local");
      setVolume(prefs.volume);
      setMuted(prefs.muted);
      setQueue((q) => ({
        ...q,
        shuffle: prefs.shuffle,
        repeat: prefs.repeat,
      }));
      setLibraryMode(prefs.libraryMode || "songs");
      setLibrarySort(prefs.librarySort || "title");
      if (prefs.compactPlayer) {
        try {
          await setCompactPlayer(true);
          setCompactPlayerState(true);
        } catch {
          setCompactPlayerState(false);
        }
      }
    } catch {
      // keep seeded prefs
    } finally {
      prefsReadyRef.current = true;
    }

    try {
      const list = await playlistStore.load();
      setPlaylists(list);
    } catch {
      setPlaylists([]);
    }
    try {
      const meta = await api.libraryMeta();
      setWatchFolders(meta.watchFolders || []);
      if (meta.musicDirectory) setMusicDirectory(meta.musicDirectory);
      else if (meta.offlineRoot) setMusicDirectory(meta.offlineRoot);
      libraryGenerationRef.current = meta.generation;
      if (meta.mode === "local" || isTauri) {
        cloudModeRef.current = false;
        offlineModeRef.current = "local";
        setCloudMode(false);
        playlistStore.setMode("local");
      }
    } catch {
      // Watch UI optional.
    }
  }, [mergeTracks]);

  useEffect(() => {
    if (!selected?.clientOnly || !selected.mediaUrl.startsWith("client-audio:")) return;
    let cancelled = false;
    void clientLibrary.materialize(selected.id)
      .then((materialized) => {
        if (!cancelled && materialized) {
          setTracks((items) => items.map((item) => item.id === materialized.id ? materialized : item));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.mediaUrl]);

  useEffect(() => {
    refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
  }, [refresh]);

  // Desktop auto-update: quiet background check (never installs without the update UI).
  useEffect(() => {
    if (!isTauri) return;
    appUpdater.scheduleStartupCheck();
    return () => appUpdater.dispose();
  }, []);

  // Hidden pages pause visual/UI work only. Audio output must remain alive.
  useEffect(() => {
    const onVis = () => {
      const visible = document.visibilityState === "visible";
      setPageVisible(visible);
      if (!visible) return;
      setCurrentTime(audioRef.current?.currentTime || 0);
      const ctx = audioContextRef.current;
      if (ctx?.state === "suspended" && !audioRef.current?.paused) {
        void ctx.resume().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Lightweight poll: only re-fetch tracks when the server generation changes (watch folder activity).
  useEffect(() => {
    if (cloudMode) return;
    const timer = window.setInterval(() => {
      api.libraryMeta()
        .then((meta) => {
          if (meta.generation === libraryGenerationRef.current) return;
          libraryGenerationRef.current = meta.generation;
          setWatchFolders(meta.watchFolders);
          return api.tracks().then((nextTracks) => {
            const merged = mergeTracks(nextTracks, cloudModeRef.current);
            setTracks(merged);
            setSelectedId((current) => {
              if (current && merged.some((track) => track.id === current)) return current;
              return merged[0]?.id || "";
            });
          });
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [cloudMode, mergeTracks]);

  useEffect(() => {
    setTitle(selected?.title || "");
    setArtist(selected?.artist || "");
    setCurrentTime(0);
    setWaveform([]);
    const audio = audioRef.current;
    const shouldAutoplay = playAfterLoadRef.current || autoplayNext;
    playAfterLoadRef.current = false;
    setAutoplayNext(false);
    if (audio) {
      if (!shouldAutoplay) audio.pause();
      audio.load();
    }
    if (!selected) {
      setPlaying(false);
      return;
    }
    let abort: AbortController | null = null;
    const cached = waveformCacheRef.current.get(selected.id);
    if (cached) {
      setWaveform(cached);
    } else if (selected.clientOnly || selected.waveformUrl.startsWith("client-waveform:")) {
      const wave = clientLibrary.waveform(selected.id);
      rememberWaveform(waveformCacheRef.current, selected.id, wave);
      setWaveform(wave);
    } else if (selected.waveformUrl.startsWith("tauri-waveform:")) {
      void api.waveform(selected.id)
        .then((wave) => {
          rememberWaveform(waveformCacheRef.current, selected.id, wave);
          setWaveform(wave);
        })
        .catch(() => setWaveform([]));
    } else {
      abort = new AbortController();
      fetch(selected.waveformUrl, {signal: abort.signal})
        .then((response) => {
          if (!response.ok) throw new Error(`Waveform request failed (${response.status})`);
          return response.json() as Promise<number[]>;
        })
        .then((wave) => {
          rememberWaveform(waveformCacheRef.current, selected.id, wave);
          setWaveform(wave);
        })
        .catch((cause: unknown) => {
          if ((cause as {name?: string}).name !== "AbortError") console.warn("Waveform decode failed", cause);
        });
    }
    if (shouldAutoplay && audio) {
      void (async () => {
        try {
          await audio.play();
        } catch {
          setPlaying(false);
        }
      })();
    }
    return () => {
      abort?.abort();
    };
  }, [selected?.id, selected?.mediaUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  useEffect(() => {
    // Avoid overwriting disk prefs with seed defaults before refresh() loads them.
    if (!prefsReadyRef.current) return;
    void savePlayerPrefs(offlineModeRef.current, {
      schemaVersion: 2,
      shuffle: queue.shuffle,
      repeat: queue.repeat,
      volume,
      muted,
      visualizerQuality: "low",
      resumeBehavior: "track",
      libraryMode,
      librarySort,
      compactPlayer,
    });
  }, [queue.shuffle, queue.repeat, volume, muted, libraryMode, librarySort, compactPlayer]);

  // Metadata-only prefetch avoids buffering or decoding two complete songs.
  useEffect(() => {
    const q = queue;
    const nextId = q.order[q.index + 1] || (q.repeat === "all" ? q.order[0] : null);
    if (!nextId || nextId === selectedId) return;
    const track = tracks.find((t) => t.id === nextId);
    if (!track?.mediaUrl) return;
    if (!prefetchRef.current) prefetchRef.current = new Audio();
    const el = prefetchRef.current;
    el.preload = "metadata";
    if (el.src !== track.mediaUrl) el.src = track.mediaUrl;
  }, [queue, selectedId, tracks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // UI time sync rides the native ~4Hz `timeupdate` event — no rAF loop, so
    // the whole app tree is not re-rendered 60 times a second while playing.
    const onPause = () => setCurrentTime(audio.currentTime);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("seeked", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("seeked", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [selected?.id]);

  // WebAudio graph (analyser + MediaStream destination) is only built when
  // Studio export needs it — normal playback goes straight through the
  // hardware audio path to avoid the extra render thread and WebRTC buffers.
  const ensureAudioGraph = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    let context = audioContextRef.current;
    if (!context) {
      context = new AudioContext();
      audioContextRef.current = context;
      const source = context.createMediaElementSource(audio);
      sourceRef.current = source;
      const nextAnalyser = context.createAnalyser();
      // Smaller FFT → less CPU/RAM for live listen mode (export uses offline analysis).
      nextAnalyser.fftSize = 256;
      nextAnalyser.smoothingTimeConstant = 0.78;
      const recordDest = context.createMediaStreamDestination();
      recordDestRef.current = recordDest;
      source.connect(nextAnalyser);
      source.connect(recordDest);
      nextAnalyser.connect(context.destination);
      setAnalyser(nextAnalyser);
    }
    if (context.state === "suspended") await context.resume();
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !selected) return;
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  };
  togglePlaybackRef.current = togglePlayback;

  const goToTrack = useCallback((trackId: string | null, autoplay: boolean) => {
    if (!trackId) {
      setPlaying(false);
      audioRef.current?.pause();
      return;
    }
    if (autoplay) playAfterLoadRef.current = true;
    setSelectedId(trackId);
    setQueue((q) => jumpTo(q, trackId));
  }, []);

  const handleTrackEnded = useCallback(() => {
    const result = onTrackEnded(queueRef.current);
    setQueue(result.queue);
    if (result.trackId && result.autoplay) {
      if (result.trackId === selectedId && queueRef.current.repeat === "one") {
        const audio = audioRef.current;
        if (audio) {
          audio.currentTime = 0;
          void audio.play().catch(() => setPlaying(false));
        }
        return;
      }
      goToTrack(result.trackId, true);
    } else {
      setPlaying(false);
    }
  }, [goToTrack, selectedId]);

  const playQueue = useCallback((trackIds: string[], options: {shuffle?: boolean; startId?: string; sourceLabel?: string; autoplay?: boolean} = {}) => {
    setQueue((q) => {
      const shuffle = options.shuffle ?? q.shuffle;
      // Only pin a start track when the caller asks for one. Defaulting to trackIds[0]
      // previously forced shuffle to always open on the playlist's first item.
      const next = createQueue(trackIds, {
        shuffle,
        repeat: q.repeat,
        startId: options.startId,
        sourceLabel: options.sourceLabel || "Library",
      });
      const id = currentId(next);
      if (id) {
        if (options.autoplay !== false) playAfterLoadRef.current = true;
        setSelectedId(id);
      }
      return next;
    });
  }, []);

  const selectAdjacent = (offset: number) => {
    if (offset > 0) {
      const result = skipNext(queueRef.current);
      setQueue(result.queue);
      if (result.trackId && result.trackId !== selectedId) goToTrack(result.trackId, playing);
      return;
    }
    const audio = audioRef.current;
    const result = skipPrev(queueRef.current, audio?.currentTime || 0);
    setQueue(result.queue);
    if (result.restart && result.trackId === selectedId && audio) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    if (result.trackId) goToTrack(result.trackId, playing);
  };

  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !selected) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: selected.title,
      artist: selected.artist,
      album: selected.album,
      artwork: selected.coverUrl && !selected.coverUrl.includes("music-note.")
        ? [{src: selected.coverUrl}]
        : undefined,
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => {
        if (audioRef.current?.paused) void togglePlaybackRef.current();
      }],
      ["pause", () => {
        if (!audioRef.current?.paused) audioRef.current?.pause();
      }],
      ["previoustrack", () => selectAdjacent(-1)],
      ["nexttrack", () => selectAdjacent(1)],
      ["seekto", (details) => {
        const audio = audioRef.current;
        if (audio && typeof details.seekTime === "number") audio.currentTime = details.seekTime;
      }],
      ["seekbackward", (details) => {
        const audio = audioRef.current;
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
      }],
      ["seekforward", (details) => {
        const audio = audioRef.current;
        if (audio) audio.currentTime = Math.min(audio.duration || Number.MAX_SAFE_INTEGER, audio.currentTime + (details.seekOffset || 10));
      }],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Optional action is not available in this browser.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Optional action.
        }
      }
    };
  }, [playing, selected?.id, queue.index]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !selected || selected.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: selected.duration,
        playbackRate: audioRef.current?.playbackRate || 1,
        position: Math.min(selected.duration, Math.max(0, currentTime)),
      });
    } catch {
      // Some browsers reject position state until metadata is fully loaded.
    }
  }, [currentTime, selected?.duration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName || "";
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        void togglePlaybackRef.current();
        return;
      }
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        setMuted((m) => !m);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setView("library");
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[aria-label="Search library"]')?.focus();
        });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (isTauri) void importFiles([]);
        else fileInputRef.current?.click();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "q") {
        event.preventDefault();
        setQueueOpen((open) => !open);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const audio = audioRef.current;
        if (!audio) return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + direction * 5));
        setCurrentTime(audio.currentTime);
        return;
      }
      if (event.altKey && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        setView(event.key === "1" ? "library" : event.key === "2" ? "playlists" : "studio");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!confirmDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmDialog(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmDialog]);

  const saveMetadata = async () => {
    if (!selected || !title.trim() || !artist.trim()) return;
    setSaving(true);
    setError("");
    try {
      if (selected.clientOnly) {
        const updated = clientLibrary.update(selected.id, {title, artist});
        if (updated) setTracks((items) => items.map((item) => item.id === updated.id ? updated : item));
      } else {
        const updated = await api.updateTrack(selected.id, {title, artist});
        setTracks((items) => items.map((item) => item.id === updated.id ? updated : item));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const importFiles = async (files: FileList | File[] = []) => {
    if (!files.length && !isTauri) return;
    setImporting(true);
    setError("");
    try {
      const lastName = Array.from(files).at(-1)?.name;
      let all: Track[];
      let skipped = 0;
      if (cloudModeRef.current) {
        const result = await clientLibrary.importFiles(files);
        all = result.tracks;
        skipped = result.skipped;
      } else {
        try {
          // Server multer clones files into the shared music library (skips replicates).
          const payload = await api.importAudio(files);
          if (Array.isArray(payload)) {
            all = mergeTracks(payload, false);
          } else {
            all = mergeTracks(payload.tracks, false);
            skipped = payload.skipped || 0;
          }
        } catch {
          // Cloud or restricted host — keep audio only in the browser.
          cloudModeRef.current = true;
          setCloudMode(true);
          const result = await clientLibrary.importFiles(files);
          all = result.tracks;
          skipped = result.skipped;
        }
      }
      setTracks(all);
      const imported = lastName
        ? all.find((track) => track.fileName === lastName)
        : all.find((track) => !tracks.some((existing) => existing.id === track.id));
      if (imported) setSelectedId(imported.id);
      setView("library");
      if (skipped > 0) {
        setError(`Skipped ${skipped} already in library (no duplicate files written).`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  /** Browser folder picker: filter by max depth using webkitRelativePath, then clone via import. */
  const importFolderFromPicker = async (files: FileList | null) => {
    if (!files?.length) return;
    const depth = Math.max(0, folderDepth);
    const list = Array.from(files).filter((file) => {
      const rel = (file as File & {webkitRelativePath?: string}).webkitRelativePath || file.name;
      // rel = "Folder/sub/file.mp3" → depth under folder root = segments after first - 1 for file
      const parts = rel.split(/[/\\]/).filter(Boolean);
      // parts[0] is root folder name; file depth = parts.length - 2 (0 = file directly in chosen folder)
      const fileDepth = Math.max(0, parts.length - 2);
      return fileDepth <= depth;
    });
    if (!list.length) {
      setError(`No audio files found at depth ≤ ${depth}. Try a higher scan layer.`);
      if (folderInputRef.current) folderInputRef.current.value = "";
      return;
    }
    await importFiles(list);
  };

  /** Local path import: server copies files into Music/Prismatic (safe to delete originals). */
  const importFolderFromPath = async (folderPath: string) => {
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setImporting(true);
    setError("");
    try {
      const result = await api.importFolder(trimmed, folderDepth);
      setTracks(mergeTracks(result.tracks, false));
      if (result.musicDirectory) setMusicDirectory(result.musicDirectory);
      const n = result.imported.length;
      if (!n && result.skipped) {
        setError(`No new files (skipped ${result.skipped} already in library).`);
      } else if (!n) {
        setError("No audio files found at that depth.");
      } else {
        setView("library");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const browseImportFolder = async () => {
    setError("");
    setImporting(true);
    try {
      const result = await api.browseWatchFolder();
      if (result?.cancelled || !result?.path) {
        setImporting(false);
        return;
      }
      setFolderPathInput(result.path);
      setImporting(false);
      await importFolderFromPath(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setImporting(false);
    }
  };

  const startRender = async () => {
    if (!selected) return;
    if (dirty) await saveMetadata();
    setError("");
    const settings = buildRenderSettings(resolution, audioBitrate);
    const id = `local-${Date.now().toString(36)}`;
    const job: RenderJob = {
      id,
      trackId: selected.id,
      trackTitle: selected.title,
      settings,
      status: "rendering",
      stage: "Preparing browser export…",
      progress: 0,
      createdAt: new Date().toISOString(),
      outputs: [],
      log: ["Encoding on your device (server stays idle)."],
    };
    setJobs((items) => [job, ...items]);
    // Offline WebCodecs path does not need the live canvas locked; keep UI free.
    setExportSize(null);
    setView("studio");

    const controller = new AbortController();
    exportAbortRef.current = controller;

    try {
      // Optional live graph for MediaRecorder fallback only
      await ensureAudioGraph().catch(() => undefined);
      const canvas = visualizerRef.current?.getCanvas();
      const audio = audioRef.current;

      const result = await exportClientVideo({
        mediaUrl: selected.mediaUrl,
        width: settings.width,
        height: settings.height,
        canvas: canvas ?? undefined,
        audio: audio ?? undefined,
        audioStream: recordDestRef.current?.stream,
        fileName: visualsFileName(selected.title),
        fps: 30,
        audioBitrateKbps: settings.audioBitrate,
        signal: controller.signal,
        onProgress: (progressValue, stage) => {
          setJobs((items) => items.map((item) =>
            item.id === id
              ? {...item, progress: progressValue, stage, status: progressValue >= 100 ? "complete" : "rendering"}
              : item,
          ));
        },
      });

      const saved: SavedRender = {fileName: result.fileName, url: result.objectUrl};
      setSavedRenders((items) => [saved, ...items]);
      setJobs((items) => items.map((item) =>
        item.id === id
          ? {
            ...item,
            status: "complete",
            stage: "Export complete — downloaded to your device",
            progress: 100,
            outputs: [{fileName: result.fileName, url: result.objectUrl}],
          }
          : item,
      ));
    } catch (cause) {
      const aborted = (cause as {name?: string}).name === "AbortError";
      setJobs((items) => items.map((item) =>
        item.id === id
          ? {
            ...item,
            status: aborted ? "cancelled" : "failed",
            stage: aborted ? "Cancelled" : "Export failed",
            error: aborted ? undefined : (cause instanceof Error ? cause.message : String(cause)),
          }
          : item,
      ));
      if (!aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExportSize(null);
      exportAbortRef.current = null;
    }
  };

  const cancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    setError("");
    try {
      exportAbortRef.current?.abort();
      setJobs((items) => items.map((item) =>
        item.id === jobId && ACTIVE_STATUSES.has(item.status)
          ? {...item, status: "cancelled", stage: "Cancelled"}
          : item,
      ));
    } finally {
      setCancellingId("");
    }
  };

  const startPlaylistExport = async (playlist: Playlist) => {
    const ordered = playlist.trackIds
      .map((id) => tracks.find((t) => t.id === id))
      .filter((t): t is Track => Boolean(t?.mediaUrl));
    if (!ordered.length) {
      setError("This playlist has no available tracks to export.");
      return;
    }
    if (jobs.some((j) => ACTIVE_STATUSES.has(j.status))) {
      setError("Finish or cancel the current export first.");
      return;
    }

    setError("");
    const settings = buildRenderSettings(resolution, audioBitrate);
    const id = `playlist-${Date.now().toString(36)}`;
    const job: RenderJob = {
      id,
      trackId: playlist.id,
      trackTitle: `${playlist.name} (${ordered.length} tracks)`,
      settings,
      status: "rendering",
      stage: "Preparing playlist export…",
      progress: 0,
      createdAt: new Date().toISOString(),
      outputs: [],
      log: [`Merging ${ordered.length} tracks in playlist order (browser encode).`],
    };
    setJobs((items) => [job, ...items]);
    setExportSize(null);
    setView("studio");

    const controller = new AbortController();
    exportAbortRef.current = controller;

    try {
      const result = await exportPlaylistClientVideo({
        tracks: ordered.map((t) => ({mediaUrl: t.mediaUrl, title: t.title})),
        width: settings.width,
        height: settings.height,
        fileName: playlistVisualsFileName(playlist.name),
        fps: 30,
        audioBitrateKbps: settings.audioBitrate,
        signal: controller.signal,
        onProgress: (progressValue, stage) => {
          setJobs((items) => items.map((item) =>
            item.id === id
              ? {...item, progress: progressValue, stage, status: progressValue >= 100 ? "complete" : "rendering"}
              : item,
          ));
        },
      });

      const saved: SavedRender = {fileName: result.fileName, url: result.objectUrl};
      setSavedRenders((items) => [saved, ...items]);
      setJobs((items) => items.map((item) =>
        item.id === id
          ? {
            ...item,
            status: "complete",
            stage: "Playlist export complete — downloaded to your device",
            progress: 100,
            outputs: [{fileName: result.fileName, url: result.objectUrl}],
          }
          : item,
      ));
    } catch (cause) {
      const aborted = (cause as {name?: string}).name === "AbortError";
      setJobs((items) => items.map((item) =>
        item.id === id
          ? {
            ...item,
            status: aborted ? "cancelled" : "failed",
            stage: aborted ? "Cancelled" : "Playlist export failed",
            error: aborted ? undefined : (cause instanceof Error ? cause.message : String(cause)),
          }
          : item,
      ));
      if (!aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExportSize(null);
      exportAbortRef.current = null;
    }
  };

  const executeRemoveTrack = async (trackId: string, deleteFile: boolean) => {
    setRemovingId(trackId);
    setError("");
    try {
      const wasCurrent = selectedId === trackId;
      const wasPlaying = wasCurrent && playing;
      if (wasPlaying) audioRef.current?.pause();
      const track = tracks.find((item) => item.id === trackId);
      let serverTracks: Track[] = [];
      if (track?.clientOnly) {
        clientLibrary.remove(trackId);
        if (!cloudModeRef.current) serverTracks = await api.tracks().catch(() => []);
      } else {
        serverTracks = await api.removeTrack(trackId, {deleteFile});
        // Also drop browser duplicate if present
        clientLibrary.remove(trackId);
      }
      const nextTracks = mergeTracks(serverTracks, cloudModeRef.current);
      setTracks(nextTracks);
      const nextQueue = removeTrackFromQueue(queueRef.current, trackId);
      setQueue(nextQueue);
      const stripped = await playlistStore.stripTrack(trackId);
      setPlaylists(stripped);

      if (wasCurrent) {
        // Prefer the track that now sits at the same queue index (next after removal).
        const successor = currentId(nextQueue)
          || nextTracks.find((item) => item.id !== trackId)?.id
          || "";
        if (successor) {
          if (wasPlaying) playAfterLoadRef.current = true;
          setSelectedId(successor);
          setQueue((q) => jumpTo(q, successor));
        } else {
          setSelectedId("");
          setPlaying(false);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemovingId("");
    }
  };

  const removeTrack = (trackId: string, _trackTitle: string) => {
    void executeRemoveTrack(trackId, true);
  };

  const executeClearLibrary = async () => {
    setError("");
    audioRef.current?.pause();
    setPlaying(false);
    try {
      // Desktop / local disk: always hit the real clear API (never pretend cloud-only wipe).
      // Cloud web: IndexedDB only.
      let result: {
        tracks: Track[];
        playlists: Playlist[];
        watchFolders: WatchFolder[];
        deletedManagedFiles: number;
        preservedExternalFiles: number;
        failedManagedFiles: string[];
      };
      if (isTauri || !cloudModeRef.current) {
        result = await api.clearLibrary();
        // Drop any stray browser-only rows so UI matches disk.
        await clientLibrary.clear().catch(() => undefined);
      } else {
        await clientLibrary.clear();
        playlistStore.clearLocal();
        result = {
          tracks: [],
          playlists: [],
          watchFolders: [],
          deletedManagedFiles: 0,
          preservedExternalFiles: 0,
          failedManagedFiles: [],
        };
      }
      if (!cloudModeRef.current || isTauri) {
        playlistStore.clearLocal();
        try {
          setPlaylists(await playlistStore.load());
        } catch {
          setPlaylists([]);
        }
      } else {
        setPlaylists([]);
      }
      setTracks(result.tracks);
      setWatchFolders(result.watchFolders || []);
      setSelectedId("");
      setQueue(createQueue([], {
        shuffle: queueRef.current.shuffle,
        repeat: queueRef.current.repeat,
        sourceLabel: "Library",
      }));
      setQueueOpen(false);
      if (result.failedManagedFiles.length) {
        setError(`Library cleared, but ${result.failedManagedFiles.length} managed file(s) could not be deleted.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearLibrary = () => {
    setConfirmDialog({
      mode: "simple",
      title: "Clear library",
      body: "Delete every Prismatic-managed music copy, playlist, and watched-folder setting? Original imported and watched files outside Prismatic will not be touched.",
      confirmLabel: "Clear library",
      danger: true,
      onConfirm: executeClearLibrary,
    });
  };

  const addWatchFolder = async (folderPath: string) => {
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setWatchBusy(true);
    setError("");
    try {
      const folders = await api.addWatchFolder(trimmed);
      setWatchFolders(folders);
      setWatchPath("");
      setTracks(await api.tracks());
      const meta = await api.libraryMeta();
      libraryGenerationRef.current = meta.generation;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWatchBusy(false);
    }
  };

  const browseWatchFolder = async () => {
    setError("");
    setWatchBusy(true);
    try {
      const result = await api.browseWatchFolder();
      if (result?.cancelled || !result?.path) {
        setWatchBusy(false);
        return;
      }
      // addWatchFolder also toggles busy; release here first so nested call can take over.
      setWatchBusy(false);
      await addWatchFolder(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setWatchBusy(false);
    }
  };

  const executeRemoveWatchFolder = async (id: string) => {
    setWatchBusy(true);
    setError("");
    try {
      setWatchFolders(await api.removeWatchFolder(id));
      setTracks(await api.tracks());
      const meta = await api.libraryMeta();
      libraryGenerationRef.current = meta.generation;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWatchBusy(false);
    }
  };

  const removeWatchFolder = (id: string, label: string) => {
    setConfirmDialog({
      mode: "simple",
      title: "Stop watching folder",
      body: `Stop watching “${label}”? Files stay on disk — they just leave the library.`,
      confirmLabel: "Stop watching",
      danger: true,
      onConfirm: () => executeRemoveWatchFolder(id),
    });
  };

  const selectTrack = (trackId: string) => {
    setQueue((q) => {
      if (q.order.includes(trackId)) return jumpTo(q, trackId);
      // Selecting outside current playlist queue switches to library queue
      return createQueue(tracks.map((t) => t.id), {
        shuffle: q.shuffle,
        repeat: q.repeat,
        startId: trackId,
        sourceLabel: "Library",
      });
    });
    setSelectedId(trackId);
    setSidebarOpen(false);
  };

  const playPlaylist = (playlist: Playlist, shuffle: boolean) => {
    const ids = playlist.trackIds.filter((id) => tracks.some((t) => t.id === id));
    if (!ids.length) {
      setError("This playlist has no available tracks.");
      return;
    }
    playQueue(ids, {shuffle, sourceLabel: playlist.name, autoplay: true});
  };

  const playPlaylistTrack = (playlist: Playlist, trackId: string) => {
    const ids = playlist.trackIds.filter((id) => tracks.some((t) => t.id === id));
    if (!ids.length) {
      setError("This playlist has no available tracks.");
      return;
    }
    playQueue(ids, {startId: trackId, sourceLabel: playlist.name, autoplay: true});
  };

  const exportZipPlaylist = async (playlist: Playlist) => {
    setZipBusy(true);
    setZipStatus("Preparing zip…");
    setError("");
    try {
      const result = await exportPlaylistZip(playlist, tracks, (message) => setZipStatus(message));
      setZipStatus(`Saved zip: ${result.path}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/cancel/i.test(message)) setError(message);
      setZipStatus("");
    } finally {
      setZipBusy(false);
    }
  };

  const importZipPlaylist = async () => {
    setZipBusy(true);
    setZipStatus("Importing zip…");
    setError("");
    try {
      const result = await importPlaylistZip({
        onProgress: (message) => setZipStatus(message),
        refreshTracks: async () => {
          const serverTracks = await api.tracks();
          const merged = mergeTracks(serverTracks, cloudModeRef.current);
          setTracks(merged);
          return merged;
        },
      });
      setPlaylists(playlistStore.list());
      const serverTracks = await api.tracks().catch(() => tracks);
      setTracks(mergeTracks(serverTracks, cloudModeRef.current));
      setZipStatus(
        `Imported “${result.playlist.name}” (${result.imported} new track${result.imported === 1 ? "" : "s"}${result.skipped ? `, ${result.skipped} skipped` : ""}).`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/cancel/i.test(message)) setError(message);
      setZipStatus("");
    } finally {
      setZipBusy(false);
    }
  };

  const nav = [
    {id: "library" as const, label: "Library", icon: Library},
    {id: "playlists" as const, label: "Playlists", icon: ListMusic},
    {id: "studio" as const, label: "Studio", icon: Clapperboard},
    {id: "settings" as const, label: "Settings", icon: Settings},
  ];

  const playTrack = (trackId: string) => {
    if (trackId === selected?.id) {
      if (audioRef.current?.paused) void togglePlayback();
      return;
    }
    playAfterLoadRef.current = true;
    selectTrack(trackId);
  };

  const addTrackToPlaylist = async (playlistId: string, trackId: string) => {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || playlist.trackIds.includes(trackId)) return;
    await playlistStore.update(playlistId, {trackIds: [...playlist.trackIds, trackId]});
    setPlaylists(playlistStore.list());
  };

  const toggleCompact = async () => {
    const next = !compactPlayer;
    try {
      await setCompactPlayer(next);
      setCompactPlayerState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const seek = useCallback((next: number) => {
    if (audioRef.current && selected) {
      audioRef.current.currentTime = next * selected.duration;
      setCurrentTime(next * selected.duration);
    }
  }, [selected]);

  const sidebarPlaylists = (
    <div className="track-list sidebar-playlists custom-scroll">
      {playlists.map((pl) => (
        <div className="track-row playlist-side-row" key={pl.id}>
          <button
            type="button"
            className="track-row-main"
            onClick={() => {
              setView("playlists");
              setSidebarOpen(false);
            }}
            onDoubleClick={() => playPlaylist(pl, false)}
          >
            <PlaylistCover trackIds={pl.trackIds} tracksById={tracksById} size={30} />
            <span className="track-copy">
              <strong>{pl.name}</strong>
              <small>{pl.trackIds.length} tracks</small>
            </span>
          </button>
          <div className="playlist-side-actions">
            <button
              type="button"
              className="icon-btn"
              disabled={!pl.trackIds.length}
              onClick={() => playPlaylist(pl, false)}
              title="Play"
              aria-label={`Play ${pl.name}`}
            >
              <PlayIcon size={13} fill="currentColor" />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!pl.trackIds.length}
              onClick={() => playPlaylist(pl, true)}
              title="Shuffle"
              aria-label={`Shuffle ${pl.name}`}
            >
              <Shuffle size={13} />
            </button>
          </div>
        </div>
      ))}
      {!loading && playlists.length === 0 && (
        <p className="empty-library">No playlists yet. Create one under Playlists.</p>
      )}
    </div>
  );

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-hidden" : ""} ${playerChromeVisible ? "player-visible" : ""}`}>
      <audio
        ref={audioRef}
        src={selected?.mediaUrl}
        crossOrigin="anonymous"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => handleTrackEnded()}
      />
      <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.flac,.m4a,.opus" multiple onChange={(event) => event.target.files && void importFiles(event.target.files)} />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          if (el) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
        }}
        className="sr-only"
        type="file"
        multiple
        onChange={(event) => void importFolderFromPicker(event.target.files)}
      />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand-row">
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button>
          <div className="brand" title={`Prismatic v${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "?"}`}>
            PRISMATIC
            <span className="brand-version">{typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : ""}</span>
          </div>
          <button type="button" className="brand-menu" onClick={() => setSidebarCollapsed(true)} aria-label="Hide navigation" title="Hide navigation"><Menu size={16} /></button>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {nav.map(({id, label, icon: Icon}) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => {setView(id); setSidebarOpen(false);}}>
              <Icon size={15} strokeWidth={1.7} />{label}
            </button>
          ))}
        </nav>
        <div className="library-heading">
          <span>Playlists</span>
          <button type="button" onClick={() => {setView("playlists"); setSidebarOpen(false); setPlaylistCreateRequest((value) => value + 1);}} aria-label="Create playlist"><Plus size={16} /></button>
        </div>
        {sidebarPlaylists}
      </aside>

      <section className="workspace">
        {sidebarCollapsed ? <button type="button" className="sidebar-restore" onClick={() => setSidebarCollapsed(false)} aria-label="Show navigation" title="Show navigation"><Menu size={17} /></button> : null}
        <header className="mobile-header"><button onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></button><span>PRISMATIC</span></header>
        {view === "library" && (
          <LibraryView
            tracks={tracks}
            playlists={playlists}
            selectedId={selected?.id || ""}
            loading={loading}
            removingId={removingId}
            query={libraryQuery}
            mode={libraryMode}
            sort={librarySort}
            TrackCover={TrackCover}
            onQuery={setLibraryQuery}
            onMode={setLibraryMode}
            onSort={setLibrarySort}
            onPlay={playTrack}
            onAddPlaylist={(playlistId, trackId) => void addTrackToPlaylist(playlistId, trackId)}
            onRemove={(id, trackTitle) => void removeTrack(id, trackTitle)}
            onClear={clearLibrary}
            onImportFiles={() => isTauri ? void importFiles([]) : fileInputRef.current?.click()}
            onImportFolder={() => isTauri ? void browseImportFolder() : folderInputRef.current?.click()}
          />
        )}
        {view === "play" && (
          <>
            <div className="stage">
              <VisualizerCanvas
                ref={visualizerRef}
                analyser={analyser}
                waveform={waveform}
                progress={progress}
                playing={playing}
                active={view === "play" && pageVisible}
                quality="low"
                exportSize={null}
              />
              {selected && <DiscPlayer key={selected.id} track={selected} playing={playing} currentTime={currentTime} progress={progress} />}
              {!selected && <div className="stage-empty"><Music2 size={42} /><h1>Import a track to play</h1></div>}
            </div>
          </>
        )}
        {view === "playlists" && (
          <PlaylistView
            playlists={playlists}
            tracks={tracks}
            TrackCover={TrackCover}
            busy={loading}
            createRequest={playlistCreateRequest}
            onCreate={async (name, trackIds) => {
              await playlistStore.create(name, trackIds);
              setPlaylists(playlistStore.list());
            }}
            onRename={async (id, name) => {
              await playlistStore.update(id, {name});
              setPlaylists(playlistStore.list());
            }}
            onDelete={(id, name) => {
              setConfirmDialog({
                mode: "simple",
                title: "Delete playlist",
                body: `Delete “${name}”? Tracks stay in your library.`,
                confirmLabel: "Delete",
                danger: true,
                onConfirm: async () => {
                  setPlaylists(await playlistStore.remove(id));
                },
              });
            }}
            onUpdateTracks={async (id, trackIds) => {
              await playlistStore.update(id, {trackIds});
              setPlaylists(playlistStore.list());
            }}
            onPlay={playPlaylist}
            onPlayTrack={playPlaylistTrack}
            onExport={(pl) => void startPlaylistExport(pl)}
            onExportZip={isTauri ? (pl) => void exportZipPlaylist(pl) : undefined}
            onImportZip={isTauri ? () => void importZipPlaylist() : undefined}
            zipBusy={zipBusy}
            zipStatus={zipStatus}
            exporting={jobs.some((j) => ACTIVE_STATUSES.has(j.status) && j.id.startsWith("playlist-"))}
          />
        )}
        {view === "settings" && (
          <div className="utility-view import-view">
            <div className="utility-heading">
              <span>Settings</span>
              <h1>Library and storage.</h1>
              <p>
                {cloudMode
                  ? "Cloud host: audio stays offline in this browser only (not shared with the desktop app)."
                  : "Imports are copied into your offline library on this PC — same folder for local web + desktop. Originals can be deleted afterward."}
                {" · "}MP3, WAV, FLAC, M4A, AAC, OGG, Opus
              </p>
            </div>
            <button className="drop-zone" onClick={() => isTauri ? void importFiles([]) : fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {event.preventDefault(); void importFiles(event.dataTransfer.files);}}>
              {importing ? <LoaderCircle className="spin" size={26} /> : <CloudUpload size={26} strokeWidth={1.4} />}
              <strong>{importing ? "Importing & copying…" : "Drop audio here"}</strong>
              <span>or choose files</span>
            </button>

            <section className="watch-panel import-folder-panel">
              <div className="watch-panel-head">
                <FolderPlus size={15} />
                <div>
                  <strong>Import from folder</strong>
                  <span>
                    Copy matching audio into the library once.
                    {musicDirectory ? ` Destination: ${musicDirectory}` : ""}
                  </span>
                </div>
              </div>
              <div className="folder-depth-row">
                <label>
                  Scan layer (depth)
                  <input
                    type="number"
                    min={0}
                    max={16}
                    value={folderDepth}
                    onChange={(event) => setFolderDepth(Math.max(0, Math.min(16, Number(event.target.value) || 0)))}
                    aria-label="Folder scan depth"
                  />
                </label>
                <span className="save-hint mono">
                  0 = only files in the folder · 1 = one subfolder level · higher = deeper
                </span>
              </div>
              <div className="watch-add-row">
                <button type="button" className="secondary-button" disabled={importing} onClick={() => folderInputRef.current?.click()}>
                  Choose folder…
                </button>
                {!cloudMode && (
                  <>
                    <input
                      value={folderPathInput}
                      onChange={(event) => setFolderPathInput(event.target.value)}
                      placeholder="D:\Music\Albums"
                      aria-label="Folder path to import"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void importFolderFromPath(folderPathInput);
                      }}
                    />
                    <button type="button" className="secondary-button" disabled={importing || !folderPathInput.trim()} onClick={() => void importFolderFromPath(folderPathInput)}>
                      Import path
                    </button>
                    <button type="button" className="secondary-button" disabled={importing} onClick={() => void browseImportFolder()}>
                      Browse…
                    </button>
                  </>
                )}
              </div>
            </section>

            {!cloudMode && (
              <section className="watch-panel">
                <div className="watch-panel-head">
                  <FolderPlus size={15} />
                  <div>
                    <strong>Watched folders</strong>
                    <span>Auto-scan a folder (and subfolders). New files appear in the library without re-importing.</span>
                  </div>
                </div>
                <div className="watch-add-row">
                  <input
                    value={watchPath}
                    onChange={(event) => setWatchPath(event.target.value)}
                    placeholder="D:\Music\Collection"
                    aria-label="Folder path to watch"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addWatchFolder(watchPath);
                    }}
                  />
                  <button type="button" className="secondary-button" disabled={watchBusy || !watchPath.trim()} onClick={() => void addWatchFolder(watchPath)}>
                    Add
                  </button>
                  <button type="button" className="secondary-button" disabled={watchBusy} onClick={() => void browseWatchFolder()}>
                    Browse…
                  </button>
                </div>
                <ul className="watch-list">
                  <li className="watch-item fixed">
                    <FolderOpen size={14} />
                    <span className="track-copy">
                      <strong>Shared library</strong>
                      <small>
                        {musicDirectory || "%USERPROFILE%\\Music\\Prismatic"}
                        {" · offline only · shared by local web + desktop"}
                      </small>
                    </span>
                  </li>
                  {watchFolders.map((folder) => (
                    <li className="watch-item" key={folder.id}>
                      <FolderOpen size={14} />
                      <span className="track-copy"><strong>{folder.label}</strong><small>{folder.path}</small></span>
                      <button type="button" className="track-remove" title="Stop watching" aria-label={`Stop watching ${folder.label}`} disabled={watchBusy} onClick={() => void removeWatchFolder(folder.id, folder.label)}>
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <UpdateSettingsCard onOpenDialog={() => setUpdateDialogOpen(true)} />
            {cloudMode && (
              <p className="save-hint mono" style={{marginTop: "1rem"}}>
                Cloud mode: audio stays in your browser. Nothing is uploaded for rendering.
              </p>
            )}
          </div>
        )}
        {view === "studio" && (
          <div className="utility-view studio-view">
            <div className="utility-heading row">
              <div>
                <span>Studio</span>
                <h1>Export visuals.</h1>
                <p>Encode a track (or whole playlist from Playlists) as video. Playback lives under Play.</p>
              </div>
              {!cloudMode && (
                <button className="secondary-button" onClick={() => void api.openOutput()}><FolderOpen size={16} />Open output folder</button>
              )}
            </div>
            <div className="studio-export-card">
              <div className="section-label">Selected track</div>
              <strong className="studio-track-name">{selected?.title || "No track selected"}</strong>
              <p className="save-hint">{selected ? `${selected.artist} · ${selected.format}` : "Pick a track in Library first."}</p>
              <div className="studio-settings-grid">
                <label>Resolution
                  <CustomSelect
                    ariaLabel="Resolution"
                    value={resolution}
                    onChange={(value) => setResolution(value as ResolutionPreset)}
                    options={[
                      {value: "720p", label: "1280 × 720 · HD"},
                      {value: "1080p", label: "1920 × 1080 · Full HD"},
                      {value: "4k", label: "3840 × 2160 · 4K"},
                      {value: "square", label: "1080 × 1080 · Square"},
                      {value: "portrait", label: "1080 × 1920 · Portrait"},
                    ]}
                  />
                </label>
                <label>Audio bitrate
                  <CustomSelect
                    ariaLabel="Audio bitrate"
                    value={String(audioBitrate)}
                    onChange={(value) => setAudioBitrate(Number(value) as 128 | 192 | 256 | 320)}
                    options={[128, 192, 256, 320].map((value) => ({value: String(value), label: `${value} kbps`}))}
                  />
                </label>
              </div>
              <p className="save-hint mono">{visualsFileName(title || selected?.title || "Track")}</p>
              <button className="render-button" onClick={() => void startRender()} disabled={!selected || Boolean(activeJob)}>
                <span>{activeJob ? activeJob.stage : "Export video"}</span>
                {activeJob ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
              </button>
              {activeJob && (
                <button className="cancel-inline" onClick={() => void cancelJob(activeJob.id)} disabled={cancellingId === activeJob.id}>
                  {cancellingId === activeJob.id ? "Stopping…" : "Cancel current export"}
                </button>
              )}
            </div>
            <div className="section-label" style={{marginTop: 20}}>Export history</div>
            <div className="render-list custom-scroll">
              {jobs.map((job) => {
                const running = ACTIVE_STATUSES.has(job.status);
                return (
                  <article className="render-row" key={job.id}>
                    <StatusMark job={job} />
                    <div><strong>{job.trackTitle}</strong><span>{job.stage}</span></div>
                    <span className="engine-label mono">{job.settings.resolution} · {job.settings.audioBitrate}k</span>
                    <div className="progress-rail"><i style={{width: `${job.progress}%`}} /></div>
                    <span className="mono percent">{job.progress}%</span>
                    <div className="render-actions">
                      {running && (
                        <button
                          className="cancel-button"
                          onClick={() => void cancelJob(job.id)}
                          disabled={cancellingId === job.id}
                          aria-label={`Cancel render for ${job.trackTitle}`}
                        >
                          {cancellingId === job.id ? <LoaderCircle className="spin" size={14} /> : <Square size={12} fill="currentColor" />}
                          <span>{cancellingId === job.id ? "Stopping…" : "Cancel"}</span>
                        </button>
                      )}
                      {job.outputs.map((output) => <a key={output.url} href={output.url} target="_blank" rel="noreferrer">View</a>)}
                    </div>
                  </article>
                );
              })}
              {jobs.length === 0 && savedRenders.map((render) => <article className="render-row saved" key={render.url}><Check size={15} /><div><strong>{render.fileName}</strong><span>Saved master</span></div><a href={render.url} target="_blank" rel="noreferrer">View video</a></article>)}
              {jobs.length === 0 && savedRenders.length === 0 && <div className="empty-renders"><Clapperboard size={30} /><strong>No exports yet</strong><span>Finished masters will appear here.</span></div>}
            </div>
          </div>
        )}
      </section>

      <aside className="inspector custom-scroll">
        <section className="track-title-panel">
          <span>{view === "studio" ? "Export track" : "Now playing"}</span>
          <h1>{selected?.title || "No track selected"}</h1>
        </section>
        <section className="inspector-section">
          <div className="section-label">Metadata {dirty && <span className="unsaved">Unsaved</span>}</div>
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!selected} /></label>
          <label>Artist<input value={artist} onChange={(event) => setArtist(event.target.value)} disabled={!selected} /></label>
          {dirty && <button className="save-button" onClick={() => void saveMetadata()} disabled={saving}><Save size={14} />{saving ? "Saving…" : "Save changes"}</button>}
        </section>
        {view === "play" && (
          <section className="status-panel">
            <div className="section-label">Player</div>
            <div className="status-line"><strong>{playing ? "Playing" : "Paused"}</strong></div>
            <p>{queue.sourceLabel} · {selected ? `${selected.format}` : "—"} · visuals optimized for listen mode</p>
            <button type="button" className="secondary-button" style={{marginTop: 12}} onClick={() => setView("studio")} disabled={!selected}>
              <Clapperboard size={14} /> Export this track…
            </button>
          </section>
        )}
        {view === "studio" && (
          <section className="status-panel">
            <div className="section-label">Status</div>
            <div className="status-line"><StatusMark job={activeJob} /><strong>{activeJob?.stage || (selected ? "Ready to export" : "Waiting for audio")}</strong></div>
            <p>{activeJob?.error || (selected ? `${selected.format} · ${selected.folder}` : "Select a track in Library.")}</p>
            {activeJob && <div className="status-progress"><i style={{width: `${activeJob.progress}%`}} /></div>}
          </section>
        )}
        {(view === "library" || view === "playlists" || view === "settings") && (
          <section className="status-panel">
            <div className="section-label">Library</div>
            <p>{tracks.length} tracks · {playlists.length} playlists</p>
            <button type="button" className="secondary-button" style={{marginTop: 12}} disabled={!selected} onClick={() => {setView("play");}}>
              <PlayIcon size={14} /> Open player
            </button>
          </section>
        )}
      </aside>

      <QueueDrawer
        open={queueOpen}
        queue={queue}
        tracksById={tracksById}
        onClose={() => setQueueOpen(false)}
        onPlay={(id) => {
          playAfterLoadRef.current = true;
          setQueue((current) => jumpTo(current, id));
          setSelectedId(id);
        }}
        onRemove={(id) => setQueue((current) => removeTrackFromQueue(current, id))}
        onMove={(from, to) => setQueue((current) => reorderQueue(current, from, to))}
        onClearUpcoming={() => setQueue((current) => {
          const order = current.order.slice(0, Math.max(0, current.index) + 1);
          const retained = new Set(order);
          return {
            ...current,
            order,
            baseOrder: current.baseOrder.filter((id) => retained.has(id)),
            updatedAt: new Date().toISOString(),
          };
        })}
      />

      {playerChromeVisible ? <PersistentPlayer
        track={selected}
        playing={playing}
        currentTime={currentTime}
        duration={selected?.duration || 0}
        volume={volume}
        muted={muted}
        shuffle={queue.shuffle}
        repeat={queue.repeat}
        compact={compactPlayer}
        onTogglePlay={() => void togglePlayback()}
        onPrev={() => selectAdjacent(-1)}
        onNext={() => selectAdjacent(1)}
        onSeek={seek}
        onVolume={(value) => {
          setVolume(value);
          if (value > 0) {
            lastVolumeRef.current = value;
            setMuted(false);
          }
        }}
        onToggleMute={() => {
          setMuted((current) => {
            if (current) {
              setVolume(lastVolumeRef.current || 0.86);
              return false;
            }
            if (volume > 0) lastVolumeRef.current = volume;
            return true;
          });
        }}
        onToggleShuffle={() => setQueue((current) => setShuffle(current, !current.shuffle))}
        onCycleRepeat={() => setQueue((current) => setRepeat(current, cycleRepeat(current.repeat)))}
        onOpenNowPlaying={() => setView("play")}
        onToggleQueue={() => setQueueOpen((open) => !open)}
        onToggleCompact={() => void toggleCompact()}
      /> : null}

      {error && <button className="error-toast" onClick={() => setError("")}><span>{error}</span><X size={16} /></button>}

      <UpdateDialog
        forceOpen={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
      />

      {confirmDialog && (
        <div className="confirm-overlay" role="presentation" onClick={() => setConfirmDialog(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-dialog-head">
              <h2 id="confirm-title">{confirmDialog.title}</h2>
              <button type="button" className="confirm-close" onClick={() => setConfirmDialog(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <p>{confirmDialog.body}</p>

            {confirmDialog.mode === "simple" && (
              <div className="confirm-actions">
                <button type="button" className="confirm-cancel" onClick={() => setConfirmDialog(null)}>Cancel</button>
                <button
                  type="button"
                  className={`confirm-ok ${confirmDialog.danger ? "danger" : ""}`}
                  autoFocus
                  onClick={() => {
                    const action = confirmDialog.onConfirm;
                    setConfirmDialog(null);
                    if (action) void action();
                  }}
                >
                  {confirmDialog.confirmLabel || "Confirm"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </main>
  );
}

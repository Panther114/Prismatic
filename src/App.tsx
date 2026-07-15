import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  ArrowRight, Check, Clapperboard, CloudUpload, FolderOpen, FolderPlus, Library,
  ListMusic, LoaderCircle, Menu, Music2, Plus, Save, Square, Trash2, X, AudioWaveform,
} from "lucide-react";
import {api} from "./api";
import {VisualizerCanvas, type VisualizerCanvasHandle} from "./components/VisualizerCanvas";
import {DiscPlayer} from "./components/DiscPlayer";
import {TransportBar} from "./components/TransportBar";
import {PlaylistView} from "./components/PlaylistView";
import {clientLibrary} from "./lib/clientLibrary";
import {exportClientVideo, exportPlaylistClientVideo} from "./lib/clientExport";
import {buildRenderSettings, playlistVisualsFileName, visualsFileName} from "./lib/resolutions";
import {playlistStore} from "./lib/playlists";
import {loadPlayerPrefs, savePlayerPrefs} from "./lib/playerPrefs";
import {
  createQueue,
  currentId,
  cycleRepeat,
  jumpTo,
  onTrackEnded,
  removeTrackFromQueue,
  setRepeat,
  setShuffle,
  skipNext,
  skipPrev,
  type QueueState,
} from "./lib/playbackQueue";
import type {Playlist, RenderJob, ResolutionPreset, SavedRender, Track, View, WatchFolder} from "./types";

const ACTIVE_STATUSES = new Set(["queued", "analyzing", "rendering"]);

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

function TrackCover({track}: {track: Track}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track.id]);
  return (
    <span className="track-cover" aria-hidden="true">
      {!failed
        ? <img src={track.coverUrl} alt="" onError={() => setFailed(true)} />
        : <img className="fallback-note" src="/music-note.png" alt="" />}
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
  const [view, setView] = useState<View>("visualize");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [savedRenders, setSavedRenders] = useState<SavedRender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cloudMode, setCloudMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [resolution, setResolution] = useState<ResolutionPreset>("1080p");
  const [audioBitrate, setAudioBitrate] = useState<128 | 192 | 256 | 320>(320);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cancellingId, setCancellingId] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [watchFolders, setWatchFolders] = useState<WatchFolder[]>([]);
  const [watchPath, setWatchPath] = useState("");
  const [watchBusy, setWatchBusy] = useState(false);
  const [exportSize, setExportSize] = useState<{width: number; height: number} | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<null | {
    mode: "simple" | "track-remove" | "track-remove-disk";
    title: string;
    body: string;
    confirmLabel?: string;
    danger?: boolean;
    trackId?: string;
    trackTitle?: string;
    onConfirm?: () => void | Promise<void>;
  }>(null);
  const initialPrefs = useMemo(() => loadPlayerPrefs(), []);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [muted, setMuted] = useState(initialPrefs.muted);
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
  const timeRafRef = useRef(0);
  const libraryGenerationRef = useRef(0);
  const cloudModeRef = useRef(false);
  const waveformCacheRef = useRef(new Map<string, number[]>());
  const lastVolumeRef = useRef(initialPrefs.volume || 0.86);
  const queueRef = useRef(queue);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);
  const playAfterLoadRef = useRef(false);
  const ensureAudioGraphRef = useRef(async () => undefined as void);

  queueRef.current = queue;

  const selected = useMemo(() => tracks.find((track) => track.id === selectedId) || tracks[0], [tracks, selectedId]);
  const activeJob = useMemo(() => jobs.find((job) => job.trackId === selected?.id && ACTIVE_STATUSES.has(job.status)), [jobs, selected?.id]);
  const dirty = Boolean(selected && (title !== selected.title || artist !== selected.artist));
  const progress = selected?.duration ? Math.min(1, currentTime / selected.duration) : 0;

  const mergeTracks = useCallback((serverTracks: Track[]) => {
    const local = clientLibrary.list();
    const byId = new Map<string, Track>();
    for (const track of serverTracks) byId.set(track.id, track);
    for (const track of local) byId.set(track.id, track);
    return [...byId.values()];
  }, []);

  const refresh = useCallback(async () => {
    await clientLibrary.hydrate().catch(() => undefined);
    const health = await api.health().catch(() => null);
    // Prefer explicit health.mode; fall back to empty local APIs.
    let modeCloud = health?.mode === "cloud";
    cloudModeRef.current = modeCloud;
    setCloudMode(modeCloud);

    let serverTracks: Track[] = [];
    if (!modeCloud) {
      try {
        serverTracks = await api.tracks();
      } catch {
        modeCloud = true;
        cloudModeRef.current = true;
        setCloudMode(true);
      }
    }
    playlistStore.setMode(modeCloud ? "cloud" : "local");
    const nextTracks = mergeTracks(serverTracks);
    setTracks(nextTracks);
    setSelectedId((current) => {
      if (current && nextTracks.some((track) => track.id === current)) return current;
      return nextTracks[0]?.id || "";
    });
    setQueue((q) => {
      if (q.order.length) return q;
      return createQueue(
        nextTracks.map((t) => t.id),
        {shuffle: q.shuffle, repeat: q.repeat, startId: nextTracks[0]?.id, sourceLabel: "Library"},
      );
    });
    try {
      const list = await playlistStore.load();
      setPlaylists(list);
    } catch {
      setPlaylists([]);
    }
    try {
      const meta = await api.libraryMeta();
      setWatchFolders(meta.watchFolders || []);
      libraryGenerationRef.current = meta.generation;
      if (meta.mode === "cloud") {
        cloudModeRef.current = true;
        setCloudMode(true);
        playlistStore.setMode("cloud");
      }
    } catch {
      // Watch UI optional.
    }
  }, [mergeTracks]);

  useEffect(() => {
    refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
  }, [refresh]);

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
            setTracks(mergeTracks(nextTracks));
            setSelectedId((current) => {
              if (current && (nextTracks.some((track) => track.id === current) || clientLibrary.list().some((t) => t.id === current))) return current;
              return mergeTracks(nextTracks)[0]?.id || "";
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
      waveformCacheRef.current.set(selected.id, wave);
      setWaveform(wave);
    } else {
      abort = new AbortController();
      fetch(selected.waveformUrl, {signal: abort.signal})
        .then((response) => {
          if (!response.ok) throw new Error(`Waveform request failed (${response.status})`);
          return response.json() as Promise<number[]>;
        })
        .then((wave) => {
          waveformCacheRef.current.set(selected.id, wave);
          setWaveform(wave);
        })
        .catch((cause: unknown) => {
          if ((cause as {name?: string}).name !== "AbortError") console.warn("Waveform decode failed", cause);
        });
    }
    if (shouldAutoplay && audio) {
      void (async () => {
        try {
          await ensureAudioGraphRef.current();
          await audio.play();
        } catch {
          setPlaying(false);
        }
      })();
    }
    return () => {
      abort?.abort();
    };
  }, [selected?.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  useEffect(() => {
    savePlayerPrefs({
      shuffle: queue.shuffle,
      repeat: queue.repeat,
      volume,
      muted,
    });
  }, [queue.shuffle, queue.repeat, volume, muted]);

  // Prefetch next track in queue for snappier skips
  useEffect(() => {
    const q = queue;
    const nextId = q.order[q.index + 1] || (q.repeat === "all" ? q.order[0] : null);
    if (!nextId || nextId === selectedId) return;
    const track = tracks.find((t) => t.id === nextId);
    if (!track?.mediaUrl) return;
    if (!prefetchRef.current) prefetchRef.current = new Audio();
    const el = prefetchRef.current;
    el.preload = "auto";
    if (el.src !== track.mediaUrl) el.src = track.mediaUrl;
  }, [queue, selectedId, tracks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const tick = () => {
      setCurrentTime(audio.currentTime);
      if (!audio.paused && !audio.ended) timeRafRef.current = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(timeRafRef.current);
      timeRafRef.current = requestAnimationFrame(tick);
    };
    const onPause = () => {
      cancelAnimationFrame(timeRafRef.current);
      setCurrentTime(audio.currentTime);
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("seeked", onPause);
    return () => {
      cancelAnimationFrame(timeRafRef.current);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("seeked", onPause);
    };
  }, [selected?.id]);

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
      nextAnalyser.fftSize = 512;
      nextAnalyser.smoothingTimeConstant = 0.74;
      const recordDest = context.createMediaStreamDestination();
      recordDestRef.current = recordDest;
      source.connect(nextAnalyser);
      source.connect(recordDest);
      nextAnalyser.connect(context.destination);
      setAnalyser(nextAnalyser);
    }
    if (context.state === "suspended") await context.resume();
  };
  ensureAudioGraphRef.current = ensureAudioGraph;

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !selected) return;
    if (audio.paused) {
      await ensureAudioGraph();
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
    const prefs = loadPlayerPrefs();
    const next = createQueue(trackIds, {
      shuffle: options.shuffle ?? prefs.shuffle,
      repeat: prefs.repeat,
      startId: options.startId || trackIds[0],
      sourceLabel: options.sourceLabel || "Library",
    });
    setQueue(next);
    const id = currentId(next);
    if (id) {
      if (options.autoplay !== false) playAfterLoadRef.current = true;
      setSelectedId(id);
    }
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
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName || "";
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (event.code === "Space" && !event.repeat && tag !== "BUTTON") {
        event.preventDefault();
        void togglePlaybackRef.current();
        return;
      }
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        setMuted((m) => !m);
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

  const importFiles = async (files: FileList | File[]) => {
    if (!files.length) return;
    setImporting(true);
    setError("");
    try {
      const lastName = Array.from(files).at(-1)?.name;
      let all: Track[];
      if (cloudModeRef.current) {
        all = await clientLibrary.importFiles(files);
      } else {
        try {
          const serverTracks = await api.importAudio(files);
          all = mergeTracks(serverTracks);
        } catch {
          // Cloud or restricted host — keep audio only in the browser.
          cloudModeRef.current = true;
          setCloudMode(true);
          all = await clientLibrary.importFiles(files);
        }
      }
      setTracks(all);
      const imported = all.find((track) => track.fileName === lastName);
      if (imported) setSelectedId(imported.id);
      setView("library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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
    // Realtime fallback still benefits from exportSize if offline fails.
    setExportSize(null);
    setView("renders");

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
    setView("renders");

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
      const wasPlaying = selectedId === trackId && playing;
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
      const nextTracks = mergeTracks(serverTracks);
      setTracks(nextTracks);
      setQueue((q) => removeTrackFromQueue(q, trackId));
      const stripped = await playlistStore.stripTrack(trackId);
      setPlaylists(stripped);
      setSelectedId((current) => {
        if (current !== trackId) return current;
        return nextTracks[0]?.id || "";
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemovingId("");
    }
  };

  const removeTrack = (trackId: string, trackTitle: string) => {
    setConfirmDialog({
      mode: "track-remove",
      title: "Remove track",
      body: `What should happen to “${trackTitle}”?`,
      trackId,
      trackTitle,
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
    setView("visualize");
  };

  const nav = [
    {id: "library" as const, label: "Library", icon: Library},
    {id: "playlists" as const, label: "Playlists", icon: ListMusic},
    {id: "import" as const, label: "Import", icon: CloudUpload},
    {id: "visualize" as const, label: "Visualize", icon: AudioWaveform},
    {id: "renders" as const, label: "Renders", icon: Clapperboard},
  ];

  const seek = useCallback((next: number) => {
    if (audioRef.current && selected) {
      audioRef.current.currentTime = next * selected.duration;
      setCurrentTime(next * selected.duration);
    }
  }, [selected]);

  const trackList = (
    <div className="track-list">
      {tracks.map((track) => (
        <div className={`track-row ${selected?.id === track.id ? "selected" : ""}`} key={track.id}>
          <button type="button" className="track-row-main" onClick={() => selectTrack(track.id)}>
            <TrackCover track={track} />
            <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>
            <time>{formatTime(track.duration)}</time>
          </button>
          <button
            type="button"
            className="track-remove"
            title="Remove from library"
            aria-label={`Remove ${track.title}`}
            disabled={removingId === track.id}
            onClick={(event) => {event.stopPropagation(); void removeTrack(track.id, track.title);}}
          >
            {removingId === track.id ? <LoaderCircle className="spin" size={12} /> : <Trash2 size={12} />}
          </button>
        </div>
      ))}
      {!loading && tracks.length === 0 && (
        <p className="empty-library">
          {cloudMode ? "Import audio in the browser to get started." : "Import audio or add a watched folder."}
        </p>
      )}
    </div>
  );

  return (
    <main className="app-shell">
      <audio
        ref={audioRef}
        src={selected?.mediaUrl}
        crossOrigin="anonymous"
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => handleTrackEnded()}
      />
      <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.flac,.m4a,.opus" multiple onChange={(event) => event.target.files && void importFiles(event.target.files)} />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand-row">
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button>
          <div className="brand">PRISMATIC</div>
          <Menu size={16} className="brand-menu" />
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {nav.map(({id, label, icon: Icon}) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => {setView(id); setSidebarOpen(false);}}>
              <Icon size={15} strokeWidth={1.7} />{label}
            </button>
          ))}
        </nav>
        {(view === "library" || view === "visualize") && (
          <>
            <div className="library-heading"><span>Your library</span><button onClick={() => fileInputRef.current?.click()} aria-label="Import audio"><Plus size={16} /></button></div>
            {trackList}
          </>
        )}
      </aside>

      <section className="workspace">
        <header className="mobile-header"><button onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></button><span>PRISMATIC</span></header>
        {view === "library" && (
          <div className="utility-view library-view">
            <div className="utility-heading">
              <span>Library</span>
              <h1>Your collection.</h1>
              <p>Select a track, open Visualize to preview, or render from the inspector.</p>
            </div>
            <div className="library-main-list">
              {tracks.map((track) => (
                <div key={track.id} className={`library-card ${selected?.id === track.id ? "selected" : ""}`}>
                  <button
                    type="button"
                    className="library-card-main"
                    onClick={() => selectTrack(track.id)}
                    onDoubleClick={() => {selectTrack(track.id); setView("visualize");}}
                  >
                    <TrackCover track={track} />
                    <span className="track-copy"><strong>{track.title}</strong><small>{track.artist}{track.album ? ` · ${track.album}` : ""} · {track.folder}</small></span>
                    <time className="mono">{formatTime(track.duration)}</time>
                  </button>
                  <button
                    type="button"
                    className="track-remove"
                    title="Remove from library"
                    aria-label={`Remove ${track.title}`}
                    disabled={removingId === track.id}
                    onClick={() => void removeTrack(track.id, track.title)}
                  >
                    {removingId === track.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              ))}
              {!loading && tracks.length === 0 && <p className="empty-library">No tracks yet. Use Import or watch a folder.</p>}
            </div>
          </div>
        )}
        {view === "visualize" && (
          <>
            <div className="stage">
              <VisualizerCanvas
                ref={visualizerRef}
                analyser={analyser}
                waveform={waveform}
                progress={progress}
                playing={playing || Boolean(exportSize)}
                exportSize={exportSize}
              />
              {selected && <DiscPlayer key={selected.id} track={selected} playing={playing} currentTime={currentTime} progress={progress} />}
              {!selected && <div className="stage-empty"><Music2 size={42} /><h1>Import a track to begin</h1></div>}
            </div>
            <TransportBar
              playing={playing}
              currentTime={currentTime}
              duration={selected?.duration || 0}
              waveform={waveform}
              volume={volume}
              muted={muted}
              shuffle={queue.shuffle}
              repeat={queue.repeat}
              sourceLabel={queue.sourceLabel}
              onTogglePlay={() => void togglePlayback()}
              onPrev={() => selectAdjacent(-1)}
              onNext={() => selectAdjacent(1)}
              onSeek={seek}
              onVolume={(value) => {
                setVolume(value);
                if (value > 0) {
                  lastVolumeRef.current = value;
                  setMuted(false);
                } else {
                  setMuted(true);
                }
              }}
              onToggleMute={() => {
                setMuted((m) => {
                  if (m) {
                    setVolume(lastVolumeRef.current || 0.86);
                    return false;
                  }
                  if (volume > 0) lastVolumeRef.current = volume;
                  return true;
                });
              }}
              onToggleShuffle={() => setQueue((q) => setShuffle(q, !q.shuffle))}
              onCycleRepeat={() => setQueue((q) => setRepeat(q, cycleRepeat(q.repeat)))}
            />
          </>
        )}
        {view === "playlists" && (
          <PlaylistView
            playlists={playlists}
            tracks={tracks}
            selectedTrackId={selectedId}
            TrackCover={TrackCover}
            busy={loading}
            onCreate={async (name) => {
              await playlistStore.create(name);
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
            onSelectTrack={selectTrack}
            onExport={(pl) => void startPlaylistExport(pl)}
            exporting={jobs.some((j) => ACTIVE_STATUSES.has(j.status) && j.id.startsWith("playlist-"))}
          />
        )}
        {view === "import" && (
          <div className="utility-view import-view">
            <div className="utility-heading"><span>Import</span><h1>Add audio.</h1><p>Tags load automatically · MP3, WAV, FLAC, M4A, AAC, OGG, Opus</p></div>
            <button className="drop-zone" onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {event.preventDefault(); void importFiles(event.dataTransfer.files);}}>
              {importing ? <LoaderCircle className="spin" size={26} /> : <CloudUpload size={26} strokeWidth={1.4} />}
              <strong>{importing ? "Reading metadata…" : "Drop audio here"}</strong>
              <span>or choose files</span>
            </button>

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
                    <span className="track-copy"><strong>music/</strong><small>Built-in project folder · always watched</small></span>
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
            {cloudMode && (
              <p className="save-hint mono" style={{marginTop: "1rem"}}>
                Cloud mode: audio stays in your browser. Nothing is uploaded for rendering.
              </p>
            )}
          </div>
        )}
        {view === "renders" && (
          <div className="utility-view renders-view">
            <div className="utility-heading row">
              <div><span>Renders</span><h1>Export history.</h1></div>
              {!cloudMode && (
                <button className="secondary-button" onClick={() => void api.openOutput()}><FolderOpen size={16} />Open output folder</button>
              )}
            </div>
            <div className="render-list">
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
              {jobs.length === 0 && savedRenders.length === 0 && <div className="empty-renders"><Clapperboard size={30} /><strong>No renders yet</strong><span>Finished masters will appear here.</span></div>}
            </div>
          </div>
        )}
      </section>

      <aside className="inspector">
        <section className="track-title-panel"><span>Track</span><h1>{selected?.title || "No track selected"}</h1></section>
        <section className="inspector-section">
          <div className="section-label">Metadata {dirty && <span className="unsaved">Unsaved</span>}</div>
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!selected} /></label>
          <label>Artist<input value={artist} onChange={(event) => setArtist(event.target.value)} disabled={!selected} /></label>
          {dirty && <button className="save-button" onClick={() => void saveMetadata()} disabled={saving}><Save size={14} />{saving ? "Saving…" : "Save changes"}</button>}
        </section>
        <section className="inspector-section render-settings">
          <div className="section-label">Render settings</div>
          <label>Resolution
            <select value={resolution} onChange={(event) => setResolution(event.target.value as ResolutionPreset)}>
              <option value="720p">1280 × 720 · HD</option><option value="1080p">1920 × 1080 · Full HD</option><option value="4k">3840 × 2160 · 4K</option><option value="square">1080 × 1080 · Square</option><option value="portrait">1080 × 1920 · Portrait</option>
            </select>
          </label>
          <label>Audio bitrate
            <select value={audioBitrate} onChange={(event) => setAudioBitrate(Number(event.target.value) as 128 | 192 | 256 | 320)}>
              <option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option>
            </select>
          </label>
          <p className="save-hint mono">
            Offline browser encode (faster than real-time) · {visualsFileName(title || selected?.title || "Track")}
          </p>
          <button className="render-button" onClick={() => void startRender()} disabled={!selected || Boolean(activeJob)}>
            <span>{activeJob ? activeJob.stage : "Export video"}</span>
            {activeJob ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
          </button>
          {activeJob && (
            <button className="cancel-inline" onClick={() => void cancelJob(activeJob.id)} disabled={cancellingId === activeJob.id}>
              {cancellingId === activeJob.id ? "Stopping…" : "Cancel current render"}
            </button>
          )}
        </section>
        <section className="status-panel">
          <div className="section-label">Status</div>
          <div className="status-line"><StatusMark job={activeJob} /><strong>{activeJob?.stage || (selected ? "Ready to export (browser)" : "Waiting for audio")}</strong></div>
          <p>{activeJob?.error || (selected ? `${selected.format} · ${selected.folder} · ${selected.bitrate ? `${Math.round(selected.bitrate / 1000)} kbps source` : "source ready"}` : "Import an audio file to begin.")}</p>
          {activeJob && <div className="status-progress"><i style={{width: `${activeJob.progress}%`}} /></div>}
        </section>
      </aside>

      {error && <button className="error-toast" onClick={() => setError("")}><span>{error}</span><X size={16} /></button>}

      {confirmDialog && (
        <div className="confirm-overlay" role="presentation" onClick={() => setConfirmDialog(null)}>
          <div
            className={`confirm-dialog ${confirmDialog.mode === "track-remove" ? "confirm-dialog-wide" : ""}`}
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

            {confirmDialog.mode === "track-remove" && confirmDialog.trackId && (
              <div className="confirm-actions confirm-actions-stack">
                <button type="button" className="confirm-cancel" onClick={() => setConfirmDialog(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-ok soft"
                  autoFocus
                  onClick={() => {
                    const id = confirmDialog.trackId!;
                    setConfirmDialog(null);
                    void executeRemoveTrack(id, false);
                  }}
                >
                  Remove from playlist
                </button>
                <button
                  type="button"
                  className="confirm-ok danger"
                  onClick={() => {
                    setConfirmDialog({
                      mode: "track-remove-disk",
                      title: "Delete from disk?",
                      body: `Permanently delete “${confirmDialog.trackTitle}” from disk? This cannot be undone.`,
                      trackId: confirmDialog.trackId,
                      trackTitle: confirmDialog.trackTitle,
                      confirmLabel: "Delete from disk",
                      danger: true,
                    });
                  }}
                >
                  Remove from disk
                </button>
              </div>
            )}

            {confirmDialog.mode === "track-remove-disk" && confirmDialog.trackId && (
              <div className="confirm-actions">
                <button
                  type="button"
                  className="confirm-cancel"
                  onClick={() => {
                    setConfirmDialog({
                      mode: "track-remove",
                      title: "Remove track",
                      body: `What should happen to “${confirmDialog.trackTitle}”?`,
                      trackId: confirmDialog.trackId,
                      trackTitle: confirmDialog.trackTitle,
                    });
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="confirm-ok danger"
                  autoFocus
                  onClick={() => {
                    const id = confirmDialog.trackId!;
                    setConfirmDialog(null);
                    void executeRemoveTrack(id, true);
                  }}
                >
                  {confirmDialog.confirmLabel || "Delete from disk"}
                </button>
              </div>
            )}

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

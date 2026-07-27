import {
  ListMusic, Maximize2, Minimize2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import {useEffect, useState} from "react";
import type {RepeatMode, Track} from "../types";
import {RangeSlider} from "./RangeSlider";

type Props = {
  track?: Track;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  compact: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (ratio: number) => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onOpenNowPlaying: () => void;
  onToggleQueue: () => void;
  onToggleCompact: () => void;
};

const formatTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};

export function PersistentPlayer(props: Props) {
  const progress = props.duration ? Math.min(1, props.currentTime / props.duration) : 0;
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => setArtFailed(false), [props.track?.id]);
  return (
    <footer className="persistent-player" aria-label="Music player">
      <button type="button" className="player-track" onClick={props.onOpenNowPlaying} disabled={!props.track}>
        {props.track ? (
          <img
            className={artFailed || props.track.coverUrl.includes("music-note.") ? "fallback-note" : ""}
            src={artFailed ? "/music-note.svg" : props.track.coverUrl}
            onError={() => setArtFailed(true)}
            alt=""
          />
        ) : <span className="player-art-empty" />}
        <span><strong>{props.track?.title || "Nothing playing"}</strong><small>{props.track?.artist || "Choose a song from your library"}</small></span>
      </button>
      <div className="player-center">
        <div className="player-controls">
          <button type="button" className={props.shuffle ? "active" : ""} onClick={props.onToggleShuffle} aria-label="Toggle shuffle"><Shuffle size={16} /></button>
          <button type="button" onClick={props.onPrev} aria-label="Previous track"><SkipBack size={18} fill="currentColor" /></button>
          <button type="button" className="player-play" onClick={props.onTogglePlay} disabled={!props.track} aria-label={props.playing ? "Pause" : "Play"}>
            {props.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button type="button" onClick={props.onNext} aria-label="Next track"><SkipForward size={18} fill="currentColor" /></button>
          <button type="button" className={props.repeat !== "off" ? "active" : ""} onClick={props.onCycleRepeat} aria-label={`Repeat ${props.repeat}`}>
            {props.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </button>
        </div>
        <div className="player-progress">
          <time>{formatTime(props.currentTime)}</time>
          <RangeSlider step={0.001} value={progress} onChange={props.onSeek} ariaLabel="Seek through track" />
          <time>{formatTime(props.duration)}</time>
        </div>
      </div>
      <div className="player-tools">
        <button type="button" onClick={props.onToggleQueue} aria-label="Open queue"><ListMusic size={17} /></button>
        <button type="button" onClick={props.onToggleMute} aria-label={props.muted ? "Unmute" : "Mute"}>
          {props.muted || props.volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <RangeSlider value={props.muted ? 0 : props.volume} onChange={props.onVolume} ariaLabel="Volume" />
        <button type="button" onClick={props.onToggleCompact} aria-label={props.compact ? "Exit mini player" : "Open mini player"}>
          {props.compact ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
        </button>
      </div>
    </footer>
  );
}

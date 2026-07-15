import {
  Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import {WaveformSeek} from "./WaveformSeek";
import type {RepeatMode} from "../types";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
};

export type TransportBarProps = {
  playing: boolean;
  currentTime: number;
  duration: number;
  waveform: number[];
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  sourceLabel: string;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (ratio: number) => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
};

export function TransportBar({
  playing,
  currentTime,
  duration,
  waveform,
  volume,
  muted,
  shuffle,
  repeat,
  sourceLabel,
  onTogglePlay,
  onPrev,
  onNext,
  onSeek,
  onVolume,
  onToggleMute,
  onToggleShuffle,
  onCycleRepeat,
}: TransportBarProps) {
  const progress = duration ? Math.min(1, currentTime / duration) : 0;
  const displayVolume = muted ? 0 : volume;

  return (
    <div className="transport">
      <div className="transport-buttons">
        <button
          type="button"
          className={shuffle ? "active-toggle" : ""}
          onClick={onToggleShuffle}
          aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
          aria-pressed={shuffle}
          title="Shuffle"
        >
          <Shuffle size={18} />
        </button>
        <button type="button" onClick={onPrev} aria-label="Previous track"><SkipBack size={22} fill="currentColor" /></button>
        <button type="button" className="play-button" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
        </button>
        <button type="button" onClick={onNext} aria-label="Next track"><SkipForward size={22} fill="currentColor" /></button>
        <button
          type="button"
          className={repeat !== "off" ? "active-toggle" : ""}
          onClick={onCycleRepeat}
          aria-label={`Repeat: ${repeat}`}
          title={`Repeat: ${repeat}`}
        >
          {repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
        </button>
      </div>
      <div className="transport-meta">
        <span className="queue-source" title={sourceLabel}>Playing from · {sourceLabel}</span>
        <div className="transport-timeline">
          <time className="mono">{formatTime(currentTime)}</time>
          <WaveformSeek waveform={waveform} progress={progress} onSeek={onSeek} />
          <time className="mono">{formatTime(duration || 0)}</time>
        </div>
      </div>
      <div className="volume-control">
        <button type="button" onClick={onToggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>
          {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          aria-label="Volume"
          type="range"
          min="0"
          max="1"
          step=".01"
          value={displayVolume}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </div>
    </div>
  );
}

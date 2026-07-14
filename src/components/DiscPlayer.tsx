import {useEffect, useState} from "react";
import type {Track} from "../types";

type Props = {track: Track; playing: boolean; currentTime: number; progress: number};

const formatTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

export function DiscPlayer({track, playing, currentTime, progress}: Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [track.id]);
  const remaining = Math.max(0, track.duration - currentTime);
  return (
    <div className="disc-player" aria-label={`${track.title} by ${track.artist}`}>
      <div className={`vinyl-shell ${playing ? "playing" : ""}`}>
        <div className="vinyl-grooves" />
        <div className="cover-label">
          {!coverFailed && <img src={track.coverUrl} alt={`${track.title} cover`} onError={() => setCoverFailed(true)} />}
          {coverFailed && <img className="fallback-note" src="/music-note.png" alt="Generic music artwork" />}
        </div>
        <i className="spindle" />
      </div>
      <div className="now-playing-copy">
        <span>Now playing</span><h1>{track.title}</h1><p>{track.artist}</p>
      </div>
      <div className="stage-progress" aria-hidden="true">
        <time>{formatTime(currentTime)}</time><div><i style={{width: `${progress * 100}%`}} /></div><time>-{formatTime(remaining)}</time>
      </div>
    </div>
  );
}

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
  const coverUrl = coverFailed || track.coverUrl.includes("music-note.") ? "/music-note.svg" : track.coverUrl;
  return (
    <div className="disc-player" aria-label={`${track.title} by ${track.artist}`}>
      <div className={`vinyl-shell ${playing ? "playing" : ""}`}>
        <div className="vinyl-face">
          <img
            className={`vinyl-art ${coverUrl.includes("music-note.") ? "fallback-note" : ""}`}
            src={coverUrl}
            alt={`${track.title} cover`}
            onError={() => setCoverFailed(true)}
          />
          <div className="vinyl-grooves" />
          <div className="vinyl-gloss" />
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

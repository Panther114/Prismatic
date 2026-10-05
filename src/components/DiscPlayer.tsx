import {memo} from "react";
import {CoverImage} from "./CoverImage";
import {useCurrentTime} from "../lib/timeStore";
import type {Track} from "../types";

type Props = {track: Track; playing: boolean};

const formatTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

const StageProgress = memo(function StageProgress({duration}: {duration: number}) {
  const currentTime = useCurrentTime();
  const progress = duration ? Math.min(1, currentTime / duration) : 0;
  return (
    <div className="stage-progress" aria-hidden="true">
      <time>{formatTime(currentTime)}</time><div><i style={{width: `${progress * 100}%`}} /></div><time>-{formatTime(Math.max(0, duration - currentTime))}</time>
    </div>
  );
});

export const DiscPlayer = memo(function DiscPlayer({track, playing}: Props) {
  return (
    <div className="disc-player" aria-label={`${track.title} by ${track.artist}`}>
      <div className={`vinyl-shell ${playing ? "playing" : ""}`}>
        <div className="vinyl-face">
          <CoverImage className="vinyl-art" src={track.coverUrl} seed={track.id} />
          <div className="vinyl-grooves" />
          <div className="vinyl-gloss" />
        </div>
        <i className="spindle" />
      </div>
      <div className="now-playing-copy">
        <span>Now playing</span><h1>{track.title}</h1><p>{track.artist}</p>
      </div>
      <StageProgress duration={track.duration} />
    </div>
  );
});

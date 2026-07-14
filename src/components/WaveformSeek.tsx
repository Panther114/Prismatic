import {memo, useMemo, type MouseEvent} from "react";

type Props = {
  waveform: number[];
  progress: number;
  onSeek: (progress: number) => void;
};

export const WaveformSeek = memo(function WaveformSeek({waveform, progress, onSeek}: Props) {
  const values = useMemo(
    () => waveform.length ? waveform : Array.from({length: 128}, (_, i) => 0.15 + Math.abs(Math.sin(i * 0.37)) * 0.35),
    [waveform],
  );
  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  };
  const playhead = progress * values.length;
  return (
    <svg className="waveform-seek" viewBox={`0 0 ${values.length} 44`} preserveAspectRatio="none" onClick={handleClick} role="slider" aria-label="Seek through track" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <defs>
        <linearGradient id="seek-gradient" x1="0" x2="1">
          <stop offset="0" stopColor="#10aaf4" />
          <stop offset=".42" stopColor="#853cff" />
          <stop offset=".72" stopColor="#f12cbf" />
          <stop offset="1" stopColor="#ffd43f" />
        </linearGradient>
      </defs>
      {values.map((value, index) => {
        // Values are already 0–1 RMS relative to track loudness; full height = louder.
        const height = 2 + Math.min(1, Math.max(0, value)) * 40;
        return <rect key={index} x={index} y={(44 - height) / 2} width=".58" height={height} rx=".25" fill={index / values.length <= progress ? "url(#seek-gradient)" : "#333a48"} />;
      })}
      <line x1={playhead} x2={playhead} y1="1" y2="43" stroke="#f7f3ea" strokeWidth=".45" />
    </svg>
  );
});

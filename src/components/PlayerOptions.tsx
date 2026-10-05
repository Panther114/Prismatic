import {Gauge, Minus, Plus} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {formatRemaining, type SleepMode} from "../hooks/useSleepTimer";
import {MAX_RATE, MIN_RATE, normalizeRate} from "../lib/playerPrefs";

type Props = {
  rate: number;
  sleep: SleepMode;
  onRate: (rate: number) => void;
  onSleep: (mode: SleepMode) => void;
};

const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_PRESETS = [15, 30, 60];

export const formatRate = (rate: number) => `${Number(rate.toFixed(2))}×`;

export function PlayerOptions({rate, sleep, onRate, onSleep}: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);

  // Countdown ticks only while the menu is open and a timer is running.
  useEffect(() => {
    if (!open || sleep?.type !== "timer") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, sleep]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const nudge = (delta: number) => onRate(normalizeRate(rate + delta));
  const active = rate !== 1 || sleep !== null;

  return (
    <div className="player-options" ref={root}>
      <button
        type="button"
        className={active ? "active" : ""}
        onClick={() => setOpen((value) => !value)}
        aria-label="Speed and sleep timer"
        aria-expanded={open}
        title="Speed and sleep timer"
      >
        <Gauge size={17} />
        {rate !== 1 && <span className="rate-badge">{formatRate(rate)}</span>}
      </button>
      {open && (
        <div className="options-popover" role="menu" aria-label="Playback options">
          <div className="options-title">Speed</div>
          <div className="rate-row">
            <button type="button" onClick={() => nudge(-0.05)} disabled={rate <= MIN_RATE} aria-label="Slower"><Minus size={12} /></button>
            <strong>{formatRate(rate)}</strong>
            <button type="button" onClick={() => nudge(0.05)} disabled={rate >= MAX_RATE} aria-label="Faster"><Plus size={12} /></button>
          </div>
          <div className="chip-row">
            {RATE_PRESETS.map((preset) => (
              <button type="button" key={preset} className={rate === preset ? "on" : ""} onClick={() => onRate(preset)}>{formatRate(preset)}</button>
            ))}
          </div>
          <div className="options-title">Sleep timer</div>
          <div className="chip-row">
            <button type="button" className={sleep === null ? "on" : ""} onClick={() => onSleep(null)}>Off</button>
            {SLEEP_PRESETS.map((minutes) => (
              <button type="button" key={minutes} onClick={() => onSleep({type: "timer", endsAt: Date.now() + minutes * 60_000})}>{minutes} min</button>
            ))}
            <button type="button" className={sleep?.type === "track" ? "on" : ""} onClick={() => onSleep({type: "track"})}>End of track</button>
          </div>
          {sleep?.type === "timer" && <p className="options-note">Stops in {formatRemaining(sleep.endsAt, now)}</p>}
          {sleep?.type === "track" && <p className="options-note">Stops after this track</p>}
        </div>
      )}
    </div>
  );
}

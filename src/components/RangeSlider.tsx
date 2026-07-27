import type {CSSProperties} from "react";

type Props = {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  className?: string;
};

export function RangeSlider({min = 0, max = 1, step = 0.01, value, onChange, ariaLabel, className = ""}: Props) {
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      className={`range-slider ${className}`}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{"--range-progress": `${Math.max(0, Math.min(100, progress))}%`} as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label={ariaLabel}
    />
  );
}

import {Music2} from "lucide-react";
import {useEffect, useState, type CSSProperties} from "react";
import {accentFromId} from "../lib/accent";
import {isRealCover} from "../lib/coverUtils";

type Props = {
  src?: string | null;
  /** Stable text (track id, playlist id) that picks the placeholder colours. */
  seed: string;
  className?: string;
  loading?: "lazy" | "eager";
};

export function placeholderStyle(seed: string): CSSProperties {
  const hue = accentFromId(seed || "prismatic").h;
  return {"--h1": hue, "--h2": (hue + 52) % 360} as CSSProperties;
}

/** Real artwork when it exists and loads; otherwise a generated gradient tile. */
export function CoverImage({src, seed, className = "", loading}: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed || !isRealCover(src)) {
    return (
      <span className={`cover-ph ${className}`.trim()} style={placeholderStyle(seed)} aria-hidden="true">
        <Music2 strokeWidth={1.6} />
      </span>
    );
  }
  return <img className={className} src={src} alt="" loading={loading} onError={() => setFailed(true)} />;
}

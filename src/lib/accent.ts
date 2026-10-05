import {useEffect, useState} from "react";

export type Accent = {h: number; s: number; l: number};

/** Stable fallback hue so every playlist keeps a recognisable colour without any image work. */
export function accentFromId(id: string): Accent {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {h: Math.abs(hash) % 360, s: 62, l: 52};
}

export function rgbToAccent(r: number, g: number, b: number): Accent {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
  }
  h = Math.round((h * 60 + 360) % 360);
  // Keep tints vivid but never so light or dark that text on top loses contrast.
  const s = Math.round(Math.min(78, Math.max(42, ((max === 0 ? 0 : d / max) * 100) + 12)));
  return {h, s, l: 50};
}

export const accentCss = (a: Accent) => `hsl(${a.h} ${a.s}% ${a.l}%)`;

const cache = new Map<string, Accent | null>();

/** Average a 8x8 downsample of the image. Returns null when pixels are unreadable (CORS). */
function sampleAccent(url: string): Promise<Accent | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext("2d", {willReadFrequently: true});
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 8, 8);
        const data = context.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2]);
          const min = Math.min(data[i], data[i + 1], data[i + 2]);
          // Favour saturated pixels so grey borders do not wash the tint out.
          const w = 1 + (max - min) / 32;
          r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; weight += w;
        }
        resolve(weight ? rgbToAccent(r / weight, g / weight, b / weight) : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Accent for an image URL, falling back to a hue derived from `fallbackId`. */
export function useAccent(url: string | undefined, fallbackId: string): Accent {
  const [accent, setAccent] = useState<Accent>(() => (url && cache.get(url)) || accentFromId(fallbackId));
  useEffect(() => {
    if (!url || url.includes("music-note.")) {
      setAccent(accentFromId(fallbackId));
      return;
    }
    if (cache.has(url)) {
      setAccent(cache.get(url) ?? accentFromId(fallbackId));
      return;
    }
    let cancelled = false;
    void sampleAccent(url).then((result) => {
      cache.set(url, result);
      if (!cancelled) setAccent(result ?? accentFromId(fallbackId));
    });
    return () => {
      cancelled = true;
    };
  }, [url, fallbackId]);
  return accent;
}

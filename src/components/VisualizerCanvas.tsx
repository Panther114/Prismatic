import {forwardRef, useEffect, useImperativeHandle, useRef} from "react";

type Props = {
  analyser: AnalyserNode | null;
  waveform: number[];
  progress: number;
  playing: boolean;
  /** When false, stop the animation loop (tab hidden / not on Play view). */
  active?: boolean;
  /** "low" caps DPR and frame rate for lighter RAM/GPU while listening. */
  quality?: "high" | "low";
  /** When set, lock canvas pixel size for browser export (instead of layout size). */
  exportSize?: {width: number; height: number} | null;
};

export type VisualizerCanvasHandle = {
  getCanvas: () => HTMLCanvasElement | null;
};

const STOPS = [
  [0, 38, 151],
  [18, 185, 255],
  [102, 69, 255],
  [242, 42, 185],
  [255, 90, 48],
  [255, 210, 63],
] as const;

/** Precomputed spectral colors for integer alpha steps — avoids string alloc per bar. */
const COLOR_LUT: string[][] = STOPS.map(() => []);
const buildLut = () => {
  for (let stop = 0; stop < STOPS.length; stop += 1) {
    COLOR_LUT[stop] = [];
  }
  for (let i = 0; i < 256; i += 1) {
    const position = i / 255;
    const scaled = position * (STOPS.length - 1);
    const index = Math.floor(scaled);
    const mix = scaled - index;
    const a = STOPS[index];
    const b = STOPS[Math.min(STOPS.length - 1, index + 1)];
    const r = Math.round(a[0] + (b[0] - a[0]) * mix);
    const g = Math.round(a[1] + (b[1] - a[1]) * mix);
    const bl = Math.round(a[2] + (b[2] - a[2]) * mix);
    // Store base without alpha; alpha applied at draw time via globalAlpha or rgba cache
    COLOR_LUT[0][i] = `${r},${g},${bl}`;
  }
};
buildLut();

function colorAt(position: number, alpha = 1) {
  const i = Math.max(0, Math.min(255, (position * 255) | 0));
  return `rgba(${COLOR_LUT[0][i]},${alpha})`;
}

/** Deterministic hash in [0,1). */
function hash01(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function sampleBins(bins: Float32Array, position: number) {
  const scaled = Math.max(0, Math.min(0.999, position)) * (bins.length - 1);
  const index = Math.floor(scaled);
  const mix = scaled - index;
  return bins[index] * (1 - mix) + bins[Math.min(bins.length - 1, index + 1)] * mix;
}

type WaterRipple = {
  x: number;
  y: number;
  birth: number;
  strength: number;
  hue: number;
  speed: number;
};

const RIPPLE_LIFE = 2.85; // seconds — expand then dissolve, never shrink
const RIPPLE_SPEED = 0.38; // fraction of min(w,h) per second
/** Cap simultaneous expanding rings so the surface stays readable. */
const MAX_CONCURRENT_RIPPLES = 3;

/**
 * Full-frame water facing the camera: soft caustic texture + beat-triggered
 * ripples that only expand outward (realistic pebble rings).
 */
function drawWaterBackground(
  context: CanvasRenderingContext2D,
  w: number,
  h: number,
  bins: Float32Array,
  bass: number,
  mid: number,
  treble: number,
  energy: number,
  nowMs: number,
  ripples: WaterRipple[],
) {
  const t = nowMs * 0.001;
  const minDim = Math.min(w, h);

  // Full-screen deep water
  const base = context.createRadialGradient(w * 0.48, h * 0.42, 0, w * 0.5, h * 0.5, minDim * 0.92);
  base.addColorStop(0, `rgba(18, 42, 72, ${0.55 + energy * 0.08})`);
  base.addColorStop(0.35, `rgba(10, 24, 48, ${0.7 + bass * 0.06})`);
  base.addColorStop(0.7, "rgba(6, 14, 30, 0.88)");
  base.addColorStop(1, "rgba(3, 7, 16, 0.96)");
  context.fillStyle = base;
  context.fillRect(0, 0, w, h);

  context.save();
  context.globalCompositeOperation = "lighter";

  // Soft caustic / refraction patches across the full plane
  const causticCount = 7;
  for (let i = 0; i < causticCount; i += 1) {
    const u = hash01(i * 13.7 + 2);
    const v = hash01(i * 7.1 + 5);
    const px = w * (0.1 + u * 0.8 + Math.sin(t * 0.13 + i) * 0.025);
    const py = h * (0.1 + v * 0.8 + Math.cos(t * 0.11 + i * 0.7) * 0.02);
    const rx = minDim * (0.12 + hash01(i * 3.2) * 0.16 + mid * 0.03);
    const ry = rx * (0.55 + hash01(i * 4.4) * 0.35);
    const g = context.createRadialGradient(px, py, 0, px, py, rx);
    g.addColorStop(0, `rgba(90, 170, 230, ${0.03 + energy * 0.035 + treble * 0.02})`);
    g.addColorStop(0.4, colorAt(0.2 + u * 0.35, 0.02 + bass * 0.02));
    g.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = g;
    context.beginPath();
    context.ellipse(px, py, rx, ry, t * 0.05 + i * 0.4, 0, Math.PI * 2);
    context.fill();
  }

  // Gentle undulating water grain (concentric soft rings ambient)
  const cx0 = w * 0.5;
  const cy0 = h * 0.48;
  for (let k = 0; k < 5; k += 1) {
    const r = minDim * (0.12 + k * 0.11 + Math.sin(t * 0.2 + k) * 0.008);
    context.strokeStyle = `rgba(140, 200, 255, ${0.018 + (1 - k / 5) * 0.012 + energy * 0.01})`;
    context.lineWidth = 1.2;
    context.beginPath();
    context.ellipse(cx0, cy0, r * (1 + bass * 0.02), r * 0.92, 0, 0, Math.PI * 2);
    context.stroke();
  }

  // Beat-spawned ripples — radius only grows with age
  for (let i = 0; i < ripples.length; i += 1) {
    const ripple = ripples[i];
    const age = (nowMs - ripple.birth) * 0.001;
    if (age < 0 || age > RIPPLE_LIFE) continue;
    const life = age / RIPPLE_LIFE;
    // Expand only; amplitude envelope fades (realistic dissipation)
    // Size scales strongly with beat strength (soft hits = small, hard hits = large)
    const sizeScale = (0.38 + ripple.strength * 1.35) * ripple.speed;
    const fade = Math.pow(1 - life, 1.65) * ripple.strength;
    if (fade < 0.015) continue;

    // Secondary wavefronts (each also only expands, delayed)
    for (let shell = 0; shell < 3; shell += 1) {
      const delay = shell * 0.11;
      const shellAge = age - delay;
      if (shellAge <= 0) continue;
      const shellLife = shellAge / RIPPLE_LIFE;
      if (shellLife >= 1) continue;
      const r = shellAge * RIPPLE_SPEED * minDim * sizeScale;
      const shellFade = Math.pow(1 - shellLife, 1.7) * ripple.strength * (1 - shell * 0.22);
      if (shellFade < 0.012 || r < 1) continue;

      // Soft glow band (simulated blur via dual strokes)
      context.strokeStyle = colorAt(ripple.hue, shellFade * 0.16);
      context.lineWidth = (2.2 + ripple.strength * 1.8) + (1 - shellLife) * (2.5 + ripple.strength * 2);
      context.beginPath();
      context.arc(ripple.x * w, ripple.y * h, r, 0, Math.PI * 2);
      context.stroke();

      context.strokeStyle = `rgba(220, 240, 255, ${shellFade * 0.2})`;
      context.lineWidth = 1 + (1 - shellLife) * 1.4;
      context.beginPath();
      context.arc(ripple.x * w, ripple.y * h, r, 0, Math.PI * 2);
      context.stroke();

      // Subtle inner trough
      context.strokeStyle = `rgba(30, 60, 100, ${shellFade * 0.08})`;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(ripple.x * w, ripple.y * h, Math.max(0.5, r - 3.5), 0, Math.PI * 2);
      context.stroke();
    }

    // Impact bloom at birth (fades fast); size follows beat strength
    if (age < 0.45) {
      const bloom = Math.pow(1 - age / 0.45, 2) * ripple.strength;
      const br = 6 + age * minDim * (0.04 + ripple.strength * 0.06) + ripple.strength * 36;
      const g = context.createRadialGradient(ripple.x * w, ripple.y * h, 0, ripple.x * w, ripple.y * h, br);
      g.addColorStop(0, `rgba(200, 235, 255, ${bloom * 0.22})`);
      g.addColorStop(0.35, colorAt(ripple.hue, bloom * 0.1));
      g.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = g;
      context.beginPath();
      context.arc(ripple.x * w, ripple.y * h, br, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.restore();
}

/** Random on-screen anchor (not pitch-mapped) so ripples scatter naturally. */
function randomRippleAnchor(seed: number): {x: number; y: number; hue: number} {
  return {
    x: 0.1 + hash01(seed) * 0.8,
    y: 0.12 + hash01(seed + 3.1) * 0.76,
    hue: (0.14 + hash01(seed + 11.7) * 0.55) % 1,
  };
}

export const VisualizerCanvas = forwardRef<VisualizerCanvasHandle, Props>(function VisualizerCanvas(
  {analyser, waveform, progress, playing, active = true, quality = "high", exportSize = null},
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastBins = useRef(new Float32Array(96));
  const propsRef = useRef({analyser, waveform, progress, playing, active, quality, exportSize});
  propsRef.current = {analyser, waveform, progress, playing, active, quality, exportSize};

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", {alpha: false, desynchronized: true});
    if (!context) return;
    let animationFrame = 0;
    let idleTimer = 0;
    let lastDraw = 0;
    let activeAnalyser: AnalyserNode | null = null;
    let frequencyBytes: Uint8Array | null = null;
    let prevEnergy = 0;
    let lastBeatMs = -9999;
    let rippleSeed = 0;
    const ripples: WaterRipple[] = [];
    const viewport = {width: 1, height: 1, ratio: 1};
    let pageVisible = typeof document === "undefined" ? true : document.visibilityState === "visible";
    const resize = () => {
      const locked = propsRef.current.exportSize;
      if (locked) {
        viewport.width = locked.width;
        viewport.height = locked.height;
        viewport.ratio = 1;
        if (canvas.width !== locked.width || canvas.height !== locked.height) {
          canvas.width = locked.width;
          canvas.height = locked.height;
        }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      viewport.width = Math.max(1, rect.width);
      viewport.height = Math.max(1, rect.height);
      // Cap DPR in low quality / play mode to cut GPU memory significantly
      const dprCap = propsRef.current.quality === "low" ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
      viewport.ratio = dprCap;
      const pixelWidth = Math.round(viewport.width * viewport.ratio);
      const pixelHeight = Math.round(viewport.height * viewport.ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const average = (values: Float32Array, start: number, end: number) => {
      let total = 0;
      for (let index = start; index < end; index += 1) total += values[index] || 0;
      return total / Math.max(1, end - start);
    };

    const draw = (now: number) => {
      const current = propsRef.current;
      const shouldRun = (current.active && pageVisible) || Boolean(current.exportSize);
      if (!shouldRun) {
        // Fully pause GPU work when tab/backgrounded or not on Play
        idleTimer = window.setTimeout(() => {
          animationFrame = requestAnimationFrame(draw);
        }, 500);
        return;
      }
      // Keep export size locked every frame (exportSize can appear mid-session).
      if (current.exportSize) resize();
      // Low quality: ~30fps while playing, ~12fps idle; high: 60/24
      const interval = current.exportSize
        ? 1000 / 60
        : current.quality === "low"
          ? (current.playing ? 1000 / 30 : 1000 / 12)
          : (current.playing ? 1000 / 60 : 1000 / 24);
      if (now - lastDraw < interval) {
        animationFrame = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;
      if (activeAnalyser !== current.analyser) {
        activeAnalyser = current.analyser;
        frequencyBytes = activeAnalyser ? new Uint8Array(activeAnalyser.frequencyBinCount) : null;
      }
      context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
      const w = viewport.width;
      const h = viewport.height;
      const horizon = h * 0.51;
      const bins = lastBins.current;

      if (activeAnalyser && frequencyBytes && current.playing) {
        activeAnalyser.getByteFrequencyData(frequencyBytes);
        const freqLen = frequencyBytes.length;
        for (let i = 0; i < bins.length; i += 1) {
          const source = Math.floor(Math.pow(i / bins.length, 1.55) * freqLen * 0.72);
          const value = frequencyBytes[Math.min(freqLen - 1, source)] / 255;
          bins[i] = bins[i] * (value > bins[i] ? 0.34 : 0.82) + value * (value > bins[i] ? 0.66 : 0.18);
        }
      } else {
        const waveLen = Math.max(1, current.waveform.length);
        const center = Math.floor(current.progress * Math.max(1, waveLen - 1));
        for (let i = 0; i < bins.length; i += 1) {
          const wave = current.waveform[(center + i * 3) % waveLen] || 0.18;
          const sculpt = 0.28 + 0.72 * Math.abs(Math.sin(i * 0.41 + current.progress * 19));
          bins[i] = bins[i] * 0.93 + wave * sculpt * 0.07;
        }
      }

      const bass = average(bins, 0, 14);
      const mid = average(bins, 18, 57);
      const treble = average(bins, 60, 96);
      const energy = bass * 0.4 + mid * 0.38 + treble * 0.22;
      const peak = Math.min(1, Math.max(0, (energy - prevEnergy) * 5.2 + energy * 0.18));
      // Drop expired ripples first so the concurrent cap is accurate
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        if ((now - ripples[i].birth) * 0.001 > RIPPLE_LIFE) ripples.splice(i, 1);
      }
      // Sensitive onset: fire on beats/notes, but never pile up rings
      if (
        current.playing
        && ripples.length < MAX_CONCURRENT_RIPPLES
        && peak > 0.07
        && energy > prevEnergy + 0.0035
        && energy > 0.035
        && now - lastBeatMs > 75
      ) {
        lastBeatMs = now;
        rippleSeed += 1;
        const strength = Math.min(1, 0.22 + peak * 0.9 + bass * 0.3 + energy * 0.18);
        const anchor = randomRippleAnchor(rippleSeed * 17.3);
        ripples.push({
          x: anchor.x,
          y: anchor.y,
          birth: now,
          strength,
          hue: anchor.hue,
          speed: 0.72 + strength * 0.55 + hash01(rippleSeed + 9) * 0.18,
        });
      }
      prevEnergy = prevEnergy * 0.72 + energy * 0.28;

      context.fillStyle = "#04080f";
      context.fillRect(0, 0, w, h);
      drawWaterBackground(context, w, h, bins, bass, mid, treble, energy, now, ripples);

      const core = context.createRadialGradient(w * 0.56, horizon, 0, w * 0.56, horizon, w * 0.28);
      core.addColorStop(0, `rgba(255, 102, 51, ${0.16 + bins[2] * 0.28})`);
      core.addColorStop(0.22, `rgba(241, 44, 191, ${0.08 + bins[10] * 0.13})`);
      core.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = core;
      context.fillRect(0, 0, w, h);

      context.save();
      context.globalCompositeOperation = "lighter";
      for (let ray = 0; ray < 24; ray += 1) {
        context.beginPath();
        context.moveTo(w * 0.56, horizon + 4);
        context.lineTo((ray / 23) * w, h);
        context.strokeStyle = colorAt(ray / 23, 0.055 + bins[ray % bins.length] * 0.06);
        context.lineWidth = 0.65;
        context.stroke();
      }
      // Fewer ribbon layers in low quality to cut fill/stroke cost
      const ribbonLayers = current.quality === "low" ? 6 : 12;
      for (let layer = ribbonLayers - 1; layer >= 0; layer -= 1) {
        const depth = layer / Math.max(1, ribbonLayers - 1);
        const register = layer % 3;
        const driver = register === 0 ? bass : register === 1 ? mid : treble;
        const threshold = 0.1 + ((layer * 29) % 5) * 0.085;
        const response = Math.max(0, (driver - threshold) / (1 - threshold));
        const softDriver = response / (1 + response * 0.72);
        const layerScale = 0.68 + ((layer * 37) % 7) * 0.05;
        const baseline = horizon + 16 + depth * h * 0.42;
        const amplitude = (12 + depth * 44) * (0.66 + softDriver * 0.58) * layerScale;
        context.beginPath();
        for (let point = 0; point <= 100; point += 1) {
          const xNorm = point / 100;
          const index = Math.min(bins.length - 1, Math.floor(xNorm * bins.length));
          const symmetry = Math.abs(xNorm - 0.55);
          const audio = bins[index];
          const primary = Math.sin(point * (register === 0 ? 0.16 : register === 1 ? 0.3 : 0.52) + layer * 0.67 + now * (0.00012 + register * 0.00007));
          const harmonic = Math.sin(point * (0.43 + register * 0.17) - now * 0.00016) * (register === 2 ? 0.25 : 0.14);
          const softAudio = audio / (1 + audio * 0.75);
          const localResponse = Math.max(0, softAudio - threshold * 0.42);
          const y = baseline - (primary + harmonic) * amplitude * (0.3 + localResponse * 0.72) - localResponse * (16 + register * 6) + symmetry * 12;
          if (point === 0) context.moveTo(xNorm * w, y);
          else context.lineTo(xNorm * w, y);
        }
        const ribbon = context.createLinearGradient(0, 0, w, 0);
        ribbon.addColorStop(0, colorAt(0, 0.12 + depth * 0.15 + softDriver * 0.08));
        ribbon.addColorStop(0.22, colorAt(0.22, 0.17 + depth * 0.17 + softDriver * 0.1));
        ribbon.addColorStop(0.52, colorAt(0.52, 0.2 + depth * 0.19 + softDriver * 0.12));
        ribbon.addColorStop(0.75, colorAt(0.75, 0.17 + depth * 0.17 + softDriver * 0.1));
        ribbon.addColorStop(1, colorAt(1, 0.12 + depth * 0.15 + softDriver * 0.08));
        context.strokeStyle = ribbon;
        context.lineWidth = 0.75 + depth * 1.02 + softDriver * 0.48;
        context.stroke();
      }

      const upperLayers = current.quality === "low" ? 1 : 3;
      for (let layer = 0; layer < upperLayers; layer += 1) {
        context.beginPath();
        for (let point = 0; point <= 100; point += 1) {
          const xNorm = point / 100;
          const index = Math.min(bins.length - 1, Math.floor(xNorm * bins.length));
          const trebleResponse = Math.max(0, treble - (0.16 + layer * 0.12));
          const y = horizon - 6 - layer * 15 - Math.sin(point * (0.36 + layer * 0.09) + layer * 0.72 + now * 0.00025) * (8 + layer * 4) * (0.38 + bins[index] * 0.58 + trebleResponse * 0.54);
          if (point === 0) context.moveTo(0, y);
          else context.lineTo(xNorm * w, y);
        }
        const upper = context.createLinearGradient(0, 0, w, 0);
        upper.addColorStop(0, colorAt(0, 0.1));
        upper.addColorStop(0.45, colorAt(0.45, 0.18));
        upper.addColorStop(0.75, colorAt(0.75, 0.17));
        upper.addColorStop(1, colorAt(1, 0.08));
        context.strokeStyle = upper;
        context.lineWidth = 0.9 + treble * 0.8;
        context.stroke();
      }

      // Shadow is expensive; skip in low quality (big GPU win)
      const barWidth = w / bins.length;
      if (current.quality !== "low") {
        context.shadowColor = colorAt(0.5, 0.55 + energy * 0.25);
        context.shadowBlur = 10 + energy * 14;
      }
      for (let i = 0; i < bins.length; i += 1) {
        const x = i * barWidth + barWidth * 0.28;
        const centerBias = 0.5 + Math.abs(i / bins.length - 0.55);
        const value = Math.max(0.025, bins[i]);
        const softValue = value / (1 + value * 0.78);
        const registerLift = i < 18 ? bass * 0.08 : i < 58 ? mid * 0.065 : treble * 0.09;
        const topHeight = (softValue + registerLift) * h * 0.34 * centerBias;
        const reflectionHeight = softValue * h * 0.2;
        context.fillStyle = colorAt(i / bins.length, 0.78 + softValue * 0.18);
        context.fillRect(x, horizon - topHeight, Math.max(1, barWidth * 0.34), topHeight + reflectionHeight);
      }
      context.shadowBlur = 0;
      context.restore();

      const vignette = context.createRadialGradient(w * 0.5, h * 0.5, h * 0.15, w * 0.5, h * 0.5, w * 0.72);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,.72)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, w, h);
      animationFrame = requestAnimationFrame(draw);
    };
    const onVisibility = () => {
      pageVisible = document.visibilityState === "visible";
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(idleTimer);
      if (pageVisible) animationFrame = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVisibility);
    animationFrame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(idleTimer);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="visualizer-canvas" aria-label="Audio-reactive spectral visualization" />;
});

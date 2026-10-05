import {forwardRef, useEffect, useImperativeHandle, useRef} from "react";
import {timeStore} from "../lib/timeStore";

type Props = {
  analyser: AnalyserNode | null;
  waveform: number[];
  /** Track length in seconds; progress is derived from the shared clock. */
  duration: number;
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

export const VisualizerCanvas = forwardRef<VisualizerCanvasHandle, Props>(function VisualizerCanvas(
  {analyser, waveform, duration, playing, active = true, quality = "high", exportSize = null},
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastBins = useRef(new Float32Array(96));
  // Progress is read lazily from the shared clock each frame, so this
  // component never re-renders just because the playback time moved.
  const propsRef = useRef({
    analyser, waveform, duration, playing, active, quality, exportSize,
    get progress() {
      return this.duration > 0 ? Math.min(1, timeStore.get() / this.duration) : 0;
    },
  });
  Object.assign(propsRef.current, {analyser, waveform, duration, playing, active, quality, exportSize});

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

    let staticFrameDrawn = false;
    const draw = (now: number) => {
      const current = propsRef.current;
      // Live audio rendering is limited to the visible Play view. Pause holds
      // a single frame; low-quality playback is capped at 12fps and DPR 1.
      const shouldRun = (current.active && pageVisible && current.playing && Boolean(current.analyser)) || Boolean(current.exportSize);
      if (!shouldRun) {
        if (!staticFrameDrawn) {
          renderFrame();
          staticFrameDrawn = true;
        }
        // Keep only a low-rate wake-up so play/pause, analyser, visibility, and
        // export state changes can restart the appropriate loop.
        idleTimer = window.setTimeout(() => {
          animationFrame = requestAnimationFrame(draw);
        }, 500);
        return;
      }
      staticFrameDrawn = false;
      // Keep export size locked every frame (exportSize can appear mid-session).
      if (current.exportSize) resize();
      // Low quality: ~12fps playback; high: ~24fps. Export always runs at 60fps.
      const interval = current.exportSize
        ? 1000 / 60
        : current.quality === "low"
          ? 1000 / 12
          : 1000 / 24;
      if (now - lastDraw < interval) {
        animationFrame = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;
      renderFrame();
      animationFrame = requestAnimationFrame(draw);
    };

    const renderFrame = () => {
      const current = propsRef.current;
      if (activeAnalyser !== current.analyser) {
        activeAnalyser = current.analyser;
        frequencyBytes = activeAnalyser ? new Uint8Array(activeAnalyser.frequencyBinCount) : null;
      }
      context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
      const w = viewport.width;
      const h = viewport.height;
      const horizon = h * 0.52;
      const minDim = Math.min(w, h);
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
      context.fillStyle = "#050714";
      context.fillRect(0, 0, w, h);

      // Reactive color fields add depth behind the angular light fan and bars.
      const coolGlow = context.createRadialGradient(w * 0.14, horizon, 0, w * 0.14, horizon, minDim * 0.8);
      coolGlow.addColorStop(0, `rgba(25, 122, 222, ${0.12 + bass * 0.12})`);
      coolGlow.addColorStop(0.48, `rgba(40, 76, 152, ${0.08 + mid * 0.06})`);
      coolGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = coolGlow;
      context.fillRect(0, 0, w, h);

      const roseGlow = context.createRadialGradient(w * 0.88, h * 0.4, 0, w * 0.88, h * 0.4, minDim * 0.72);
      roseGlow.addColorStop(0, `rgba(207, 56, 151, ${0.1 + treble * 0.12})`);
      roseGlow.addColorStop(0.5, `rgba(94, 51, 148, ${0.07 + mid * 0.05})`);
      roseGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = roseGlow;
      context.fillRect(0, 0, w, h);

      const spectrumWash = context.createLinearGradient(0, horizon - h * 0.24, w, horizon + h * 0.24);
      spectrumWash.addColorStop(0, `rgba(19, 184, 255, ${0.035 + bass * 0.04})`);
      spectrumWash.addColorStop(0.52, `rgba(111, 71, 255, ${0.045 + energy * 0.055})`);
      spectrumWash.addColorStop(1, `rgba(242, 42, 185, ${0.035 + treble * 0.04})`);
      context.fillStyle = spectrumWash;
      context.fillRect(0, 0, w, h);

      context.save();
      context.globalCompositeOperation = "lighter";
      const rayCount = current.quality === "low" ? 20 : 32;
      for (let ray = 0; ray < rayCount; ray += 1) {
        const position = ray / (rayCount - 1);
        const response = bins[(ray * 5) % bins.length];
        context.beginPath();
        context.moveTo(w * 0.52, horizon);
        context.lineTo(position * w, h);
        context.strokeStyle = colorAt(position, 0.025 + response * 0.075);
        context.lineWidth = 0.55 + response * 0.55;
        context.stroke();
      }

      const barWidth = w / bins.length;
      if (current.quality !== "low") {
        context.shadowColor = colorAt(0.52, 0.35 + energy * 0.3);
        context.shadowBlur = 8 + energy * 12;
      }
      for (let i = 0; i < bins.length; i += 1) {
        const x = i * barWidth + barWidth * 0.28;
        const centerBias = 0.5 + Math.abs(i / bins.length - 0.55);
        const value = Math.max(0.025, bins[i]);
        const softValue = value / (1 + value * 0.78);
        const registerLift = i < 18 ? bass * 0.08 : i < 58 ? mid * 0.065 : treble * 0.09;
        const height = Math.max(2, (softValue + registerLift) * h * 0.38 * centerBias);
        context.fillStyle = colorAt(i / bins.length, 0.78 + softValue * 0.18);
        context.fillRect(x, horizon - height, Math.max(1, barWidth * 0.44), height);
      }
      context.shadowBlur = 0;
      context.restore();

      const vignette = context.createRadialGradient(w * 0.5, h * 0.5, h * 0.15, w * 0.5, h * 0.5, w * 0.72);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 0, 0, .72)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, w, h);
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

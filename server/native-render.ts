import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {promises as fs} from "node:fs";
import path from "node:path";
import {createCanvas, loadImage, type SKRSContext2D, type Canvas, type Image} from "@napi-rs/canvas";
import type {AudioAnalysis, RenderJob, RenderSettings} from "./types.js";

const FPS = 30;
const STOPS: Array<[number, number, number]> = [
  [0, 38, 151],
  [18, 185, 255],
  [102, 69, 255],
  [242, 42, 185],
  [255, 90, 48],
  [255, 210, 63],
];

/** Precomputed rgb strings for 256 spectrum steps — avoids per-call interpolation. */
const RGB_LUT: string[] = new Array(256);
for (let i = 0; i < 256; i += 1) {
  const scaled = (i / 255) * (STOPS.length - 1);
  const index = Math.floor(scaled);
  const mix = scaled - index;
  const a = STOPS[index];
  const b = STOPS[Math.min(STOPS.length - 1, index + 1)];
  RGB_LUT[i] = `${Math.round(a[0] + (b[0] - a[0]) * mix)},${Math.round(a[1] + (b[1] - a[1]) * mix)},${Math.round(a[2] + (b[2] - a[2]) * mix)}`;
}

export class RenderCancelledError extends Error {
  constructor(message = "Render cancelled") {
    super(message);
    this.name = "RenderCancelledError";
  }
}

function colorAt(position: number, alpha = 1) {
  const i = Math.max(0, Math.min(255, (position * 255) | 0));
  return `rgba(${RGB_LUT[i]},${alpha})`;
}

function sampleBand(bands: number[], position: number) {
  const scaled = Math.max(0, Math.min(0.999, position)) * (bands.length - 1);
  const index = Math.floor(scaled);
  const mix = scaled - index;
  return bands[index] * (1 - mix) + bands[Math.min(bands.length - 1, index + 1)] * mix;
}

/** Deterministic hash in [0,1). Same inputs → same grain motion forever. */
function hash01(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

type VideoEncoder = "h264_nvenc" | "h264_amf" | "h264_qsv" | "libx264";
let encoderCache: VideoEncoder | null = null;

async function encoderWorks(encoder: Exclude<VideoEncoder, "libx264">): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30",
      "-frames:v", "1",
      "-c:v", encoder,
      ...(encoder === "h264_nvenc" ? ["-preset", "p4"] : encoder === "h264_amf" ? ["-quality", "speed"] : ["-preset", "veryfast"]),
      "-f", "null", "-",
    ], {windowsHide: true});
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function pickVideoEncoder(): Promise<VideoEncoder> {
  if (encoderCache) return encoderCache;
  const listed = await new Promise<string>((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-encoders"], {windowsHide: true});
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.on("close", () => resolve(text));
    child.on("error", () => resolve(""));
  });
  const candidates: Array<Exclude<VideoEncoder, "libx264">> = [];
  if (listed.includes("h264_nvenc")) candidates.push("h264_nvenc");
  if (listed.includes("h264_amf")) candidates.push("h264_amf");
  if (listed.includes("h264_qsv")) candidates.push("h264_qsv");
  for (const candidate of candidates) {
    if (await encoderWorks(candidate)) {
      encoderCache = candidate;
      return encoderCache;
    }
  }
  encoderCache = "libx264";
  return encoderCache;
}

function videoEncoderArgs(encoder: VideoEncoder) {
  // Visually transparent quality targets (CQ/CRF ~18 ≈ transparent for screen content)
  if (encoder === "h264_nvenc") {
    return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "18", "-b:v", "0", "-profile:v", "high", "-spatial-aq", "1"];
  }
  if (encoder === "h264_amf") {
    return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18"];
  }
  if (encoder === "h264_qsv") {
    return ["-c:v", "h264_qsv", "-global_quality", "18", "-preset", "faster", "-look_ahead", "0"];
  }
  return [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high",
    "-tune", "animation", "-x264-params", "ref=3:bframes=2:aq-mode=1",
  ];
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new RenderCancelledError();
}

type FrameAudio = AudioAnalysis["frames"][number];

const RIPPLE_LIFE = 2.85;
const RIPPLE_SPEED = 0.38;
/** Cap simultaneous expanding rings so the surface stays readable. */
const MAX_CONCURRENT_RIPPLES = 3;

type BeatRipple = {
  birthFrame: number;
  x: number;
  y: number;
  strength: number;
  hue: number;
  speed: number;
};

/** Local-max peak onsets → deterministic full-frame facing ripples. */
function extractBeatRipples(analysis: AudioAnalysis): BeatRipple[] {
  const beats: BeatRipple[] = [];
  let last = -999;
  const frames = analysis.frames;
  const lifeFrames = Math.ceil(RIPPLE_LIFE * FPS);
  for (let i = 1; i < frames.length - 1; i += 1) {
    const f = frames[i];
    const prev = frames[i - 1];
    const next = frames[i + 1];
    // Lower thresholds: catch softer beats/notes while still requiring a local peak
    if (
      f.peak < 0.055
      || f.peak < prev.peak
      || f.peak < next.peak
      || f.energy < 0.03
      || i - last < 2
    ) continue;

    const birthFrame = Math.round((i / analysis.fps) * FPS);
    // Skip if too many rings would still be expanding at this moment
    let live = 0;
    for (let b = beats.length - 1; b >= 0; b -= 1) {
      const age = birthFrame - beats[b].birthFrame;
      if (age < 0) continue;
      if (age <= lifeFrames) live += 1;
      else break; // older entries are earlier
    }
    if (live >= MAX_CONCURRENT_RIPPLES) continue;

    last = i;
    const seed = i * 19.17 + f.peak * 40;
    const strength = Math.min(1, 0.22 + f.peak * 0.9 + f.bass * 0.3 + f.energy * 0.18);
    // Random placement (deterministic per frame), not pitch/centroid mapped
    const x = 0.1 + hash01(seed) * 0.8;
    const y = 0.12 + hash01(seed + 3.1) * 0.76;
    beats.push({
      birthFrame,
      x,
      y,
      strength,
      hue: (0.14 + hash01(seed + 11.7) * 0.55) % 1,
      speed: 0.72 + strength * 0.55 + hash01(seed + 9) * 0.18,
    });
  }
  return beats;
}

/**
 * Full-frame water facing the camera. Beat ripples only expand outward.
 */
function drawWaterBackground(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  audio: FrameAudio,
  frame: number,
  ripples: BeatRipple[],
) {
  const t = frame / FPS;
  const minDim = Math.min(width, height);
  const {bass, mid, treble, energy} = audio;

  const base = ctx.createRadialGradient(width * 0.48, height * 0.42, 0, width * 0.5, height * 0.5, minDim * 0.92);
  base.addColorStop(0, `rgba(18, 42, 72, ${0.55 + energy * 0.08})`);
  base.addColorStop(0.35, `rgba(10, 24, 48, ${0.7 + bass * 0.06})`);
  base.addColorStop(0.7, "rgba(6, 14, 30, 0.88)");
  base.addColorStop(1, "rgba(3, 7, 16, 0.96)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  for (let i = 0; i < 7; i += 1) {
    const u = hash01(i * 13.7 + 2);
    const v = hash01(i * 7.1 + 5);
    const px = width * (0.1 + u * 0.8 + Math.sin(t * 0.13 + i) * 0.025);
    const py = height * (0.1 + v * 0.8 + Math.cos(t * 0.11 + i * 0.7) * 0.02);
    const rx = minDim * (0.12 + hash01(i * 3.2) * 0.16 + mid * 0.03);
    const ry = rx * (0.55 + hash01(i * 4.4) * 0.35);
    const g = ctx.createRadialGradient(px, py, 0, px, py, rx);
    g.addColorStop(0, `rgba(90, 170, 230, ${0.03 + energy * 0.035 + treble * 0.02})`);
    g.addColorStop(0.4, colorAt(0.2 + u * 0.35, 0.02 + bass * 0.02));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(px, py, rx, ry, t * 0.05 + i * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx0 = width * 0.5;
  const cy0 = height * 0.48;
  for (let k = 0; k < 5; k += 1) {
    const r = minDim * (0.12 + k * 0.11 + Math.sin(t * 0.2 + k) * 0.008);
    ctx.strokeStyle = `rgba(140, 200, 255, ${0.018 + (1 - k / 5) * 0.012 + energy * 0.01})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(cx0, cy0, r * (1 + bass * 0.02), r * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (let i = 0; i < ripples.length; i += 1) {
    const ripple = ripples[i];
    const age = (frame - ripple.birthFrame) / FPS;
    if (age < 0 || age > RIPPLE_LIFE) continue;

    for (let shell = 0; shell < 3; shell += 1) {
      const delay = shell * 0.11;
      const shellAge = age - delay;
      if (shellAge <= 0) continue;
      const shellLife = shellAge / RIPPLE_LIFE;
      if (shellLife >= 1) continue;
      // Radius only grows with time — never retracts
      const sizeScale = (0.38 + ripple.strength * 1.35) * ripple.speed;
      const r = shellAge * RIPPLE_SPEED * minDim * sizeScale;
      const shellFade = Math.pow(1 - shellLife, 1.7) * ripple.strength * (1 - shell * 0.22);
      if (shellFade < 0.012 || r < 1) continue;

      ctx.strokeStyle = colorAt(ripple.hue, shellFade * 0.16);
      ctx.lineWidth = (2.2 + ripple.strength * 1.8) + (1 - shellLife) * (2.5 + ripple.strength * 2);
      ctx.beginPath();
      ctx.arc(ripple.x * width, ripple.y * height, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(220, 240, 255, ${shellFade * 0.2})`;
      ctx.lineWidth = 1 + (1 - shellLife) * 1.4;
      ctx.beginPath();
      ctx.arc(ripple.x * width, ripple.y * height, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(30, 60, 100, ${shellFade * 0.08})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ripple.x * width, ripple.y * height, Math.max(0.5, r - 3.5), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (age < 0.45) {
      const bloom = Math.pow(1 - age / 0.45, 2) * ripple.strength;
      const br = 6 + age * minDim * (0.04 + ripple.strength * 0.06) + ripple.strength * 36;
      const g = ctx.createRadialGradient(ripple.x * width, ripple.y * height, 0, ripple.x * width, ripple.y * height, br);
      g.addColorStop(0, `rgba(200, 235, 255, ${bloom * 0.22})`);
      g.addColorStop(0.35, colorAt(ripple.hue, bloom * 0.1));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ripple.x * width, ripple.y * height, br, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

type DrawCache = {
  width: number;
  height: number;
  bg: CanvasGradient;
  vignette: CanvasGradient;
  fade: CanvasGradient;
};

function buildDrawCache(ctx: SKRSContext2D, width: number, height: number): DrawCache {
  const bg = ctx.createRadialGradient(width * 0.48, height * 0.42, 0, width * 0.5, height * 0.5, Math.min(width, height) * 0.92);
  bg.addColorStop(0, "rgba(18, 42, 72, 0.55)");
  bg.addColorStop(0.4, "rgba(10, 24, 48, 0.75)");
  bg.addColorStop(1, "rgba(3, 7, 16, 0.96)");
  const vignette = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.15, width * 0.5, height * 0.5, width * 0.72);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.72)");
  const fade = ctx.createLinearGradient(0, height * 0.78, 0, height);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,0.84)");
  return {width, height, bg, vignette, fade};
}

function drawFrame(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  analysis: AudioAnalysis,
  frame: number,
  title: string,
  artist: string,
  cover: Image | null,
  noteImage: Image | null,
  totalFrames: number,
  cache: DrawCache,
  beatRipples: BeatRipple[],
) {
  const audio = analysis.frames[Math.min(analysis.frames.length - 1, Math.floor((frame / FPS) * analysis.fps))] || analysis.frames[0];
  const scale = Math.min(width / 1920, height / 1080);
  const horizon = height * 0.49;
  const vanishingX = width * 0.526 + Math.sin(frame / 180) * 24 * scale;
  const intro = Math.min(1, frame / 24);
  const outroStart = totalFrames - 48;
  const outro = frame >= outroStart ? Math.max(0, 1 - (frame - outroStart) / 47) : 1;
  const zoom = 1 + audio.bass * 0.018 + audio.peak * 0.012;
  const unit = Math.min(width, height) / 1080;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#04080f";
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = intro * outro;
  ctx.translate(width / 2, height / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-width / 2, -height / 2);

  drawWaterBackground(ctx, width, height, audio, frame, beatRipples);

  const core = ctx.createRadialGradient(vanishingX, horizon, 0, vanishingX, horizon, (280 + audio.bass * 210) * scale);
  core.addColorStop(0, `rgba(255, 106, 50, ${0.42 + audio.energy * 0.35})`);
  core.addColorStop(0.24, `rgba(227, 44, 174, ${0.12 + audio.mid * 0.2})`);
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.ellipse(vanishingX, horizon, (280 + audio.bass * 210) * scale, (115 + audio.bass * 70) * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = (0.14 + audio.energy * 0.08) * intro * outro;
  for (let index = 0; index < 22; index += 1) {
    const bottomX = (index / 21) * width;
    ctx.beginPath();
    ctx.moveTo(vanishingX, horizon + 12);
    ctx.lineTo(bottomX, height);
    ctx.strokeStyle = colorAt(index / 21, 0.46);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (let index = 0; index < 10; index += 1) {
    const y = horizon + 24 + Math.pow(index / 9, 1.8) * (height - horizon - 24);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.strokeStyle = `rgba(111, 90, 200, ${0.22 - index * 0.012})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.globalAlpha = intro * outro;
  const barCount = 96;
  for (let index = 0; index < barCount; index += 1) {
    const position = index / (barCount - 1);
    const value = sampleBand(audio.bands, Math.pow(position, 1.18));
    const softValue = value / (1 + value * 0.72);
    const x = position * width;
    const edge = 0.72 + Math.abs(position - 0.53) * 0.64;
    const topHeight = (20 + softValue * 330 * edge + audio.peak * 42 * Math.sin(index * 1.9) ** 2) * scale;
    const reflection = (16 + softValue * 190) * scale;
    const barWidth = 2.2 + value * 1.7;
    ctx.fillStyle = colorAt(position, 0.45 + value * 0.48);
    ctx.fillRect(x, horizon - topHeight, barWidth, topHeight);
    ctx.fillStyle = colorAt(position, (0.25 + value * 0.35) * (0.82 - reflection / 800));
    ctx.fillRect(x, horizon + 4, barWidth, reflection);
  }

  // Ribbon layers: slightly fewer samples (80 vs 96) — visually identical at 1080p
  for (let layer = 0; layer < 11; layer += 1) {
    const depth = layer / 10;
    const register = layer % 3;
    const driver = register === 0 ? audio.bass : register === 1 ? audio.mid : audio.treble;
    const threshold = 0.1 + ((layer * 29) % 5) * 0.085;
    const response = Math.max(0, (driver - threshold) / (1 - threshold));
    const softDriver = response / (1 + response * 0.72);
    const layerScale = 0.68 + ((layer * 37) % 7) * 0.05;
    const baseline = horizon + (38 + depth * 405) * scale;
    ctx.beginPath();
    for (let index = 0; index <= 80; index += 1) {
      const position = index / 80;
      const bandPosition = register === 0 ? position * 0.24 : register === 1 ? 0.18 + position * 0.5 : 0.48 + position * 0.5;
      const band = sampleBand(audio.bands, bandPosition);
      const softBand = band / (1 + band * 0.7);
      const phase = index * (register === 0 ? 0.144 : register === 1 ? 0.288 : 0.516) + layer * 0.68 + frame * (0.008 + register * 0.003 + softDriver * 0.004);
      const harmonic = Math.sin(phase * (register === 2 ? 2.1 : 1.5) + layer) * softDriver;
      const localResponse = Math.max(0, softBand - threshold * 0.42);
      const envelope = 0.32 + localResponse * 0.72 + softDriver * 0.18;
      const amplitude = ((register === 0 ? 14 : register === 1 ? 11 : 8) + depth * (register === 0 ? 44 : register === 1 ? 35 : 27)) * layerScale;
      const y = baseline - (Math.sin(phase) + harmonic * 0.24) * amplitude * envelope * scale - localResponse * (17 + depth * 22) * scale;
      const perspectiveX = vanishingX + (position * width - vanishingX) * (0.48 + depth * 0.58);
      if (index === 0) ctx.moveTo(perspectiveX, y);
      else ctx.lineTo(perspectiveX, y);
    }
    ctx.strokeStyle = colorAt((layer * 0.079 + 0.08) % 1, 0.22 + depth * 0.21 + softDriver * 0.08);
    ctx.lineWidth = 0.8 + depth * 1.05 + softDriver * 0.42;
    ctx.stroke();
  }

  ctx.fillStyle = cache.fade;
  ctx.fillRect(0, height * 0.78, width, height * 0.22);
  ctx.restore();

  // Player overlay
  const entrance = Math.min(1, Math.max(0, (frame - 8) / 26));
  ctx.save();
  ctx.globalAlpha = entrance * outro;
  const discSize = Math.min(width, height) * 0.34;
  const discX = width / 2;
  const discY = height * (height > width ? 0.18 : 0.12) + discSize / 2;
  const rotation = ((frame / FPS) * (Math.PI * 2)) / 13;
  const pulse = 1 + audio.bass * 0.018 + audio.peak * 0.012;

  ctx.translate(discX, discY);
  ctx.rotate(rotation);
  ctx.scale(pulse, pulse);
  const vinyl = ctx.createRadialGradient(0, 0, 0, 0, 0, discSize / 2);
  vinyl.addColorStop(0, "#14131b");
  vinyl.addColorStop(0.07, "#14131b");
  vinyl.addColorStop(0.075, "#050509");
  vinyl.addColorStop(0.29, "#050509");
  vinyl.addColorStop(0.295, "#17141e");
  vinyl.addColorStop(0.305, "#17141e");
  vinyl.addColorStop(0.31, "#06070b");
  vinyl.addColorStop(0.58, "#06070b");
  vinyl.addColorStop(0.585, "#121018");
  vinyl.addColorStop(0.595, "#121018");
  vinyl.addColorStop(0.6, "#05060a");
  vinyl.addColorStop(1, "#05060a");
  ctx.fillStyle = vinyl;
  ctx.beginPath();
  ctx.arc(0, 0, discSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1.5 * unit;
  ctx.stroke();
  ctx.shadowColor = "rgba(112,71,255,0.28)";
  ctx.shadowBlur = 18 * unit;
  ctx.strokeStyle = "rgba(112,71,255,0.28)";
  ctx.lineWidth = 5 * unit;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const coverRadius = discSize * 0.21;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, coverRadius, 0, Math.PI * 2);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, -coverRadius, -coverRadius, coverRadius * 2, coverRadius * 2);
  } else {
    const label = ctx.createRadialGradient(-coverRadius * 0.4, -coverRadius * 0.5, 0, 0, 0, coverRadius);
    label.addColorStop(0, "#ff8b43");
    label.addColorStop(0.36, "#df287d");
    label.addColorStop(0.73, "#512db7");
    label.addColorStop(1, "#0e1735");
    ctx.fillStyle = label;
    ctx.fillRect(-coverRadius, -coverRadius, coverRadius * 2, coverRadius * 2);
    if (noteImage) {
      const size = coverRadius * 1.52;
      ctx.drawImage(noteImage, -size / 2, -size / 2, size, size);
    }
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(243,240,232,0.78)";
  ctx.lineWidth = 3 * unit;
  ctx.beginPath();
  ctx.arc(0, 0, coverRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#f3f0e8";
  ctx.beginPath();
  ctx.arc(0, 0, 5 * unit, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = entrance * outro;
  ctx.textAlign = "center";
  ctx.fillStyle = "#aeb5c3";
  ctx.font = `${Math.round(16 * unit)}px "JetBrains Mono", monospace`;
  const textY = discY + discSize / 2 + 28 * unit;
  ctx.fillText("NOW PLAYING", width / 2, textY);
  ctx.fillStyle = "#f3f0e8";
  ctx.font = `700 ${Math.round(72 * unit)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  ctx.shadowColor = `rgba(111,71,255,${0.34 + audio.treble * 0.2})`;
  ctx.shadowBlur = 18 + audio.treble * 20;
  const titleY = textY + 10 * unit + 52 * unit;
  ctx.fillText(title.length > 42 ? `${title.slice(0, 41)}…` : title, width / 2, titleY, width * 0.86);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#c8cbd3";
  ctx.font = `300 ${Math.round(28 * unit)}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  ctx.fillText(artist.length > 48 ? `${artist.slice(0, 47)}…` : artist, width / 2, titleY + 12 * unit + 24 * unit, width * 0.86);

  const progressWidth = Math.min(width * 0.56, 920 * unit);
  const progressY = height * 0.93;
  const elapsed = frame / FPS;
  const remaining = Math.max(0, totalFrames / FPS - elapsed);
  ctx.font = `${Math.round(15 * unit)}px "JetBrains Mono", monospace`;
  ctx.fillStyle = "#d7d8dc";
  ctx.textAlign = "right";
  ctx.fillText(formatTime(elapsed), width / 2 - progressWidth / 2 - 18 * unit, progressY + 5 * unit);
  ctx.textAlign = "left";
  ctx.fillText(`-${formatTime(remaining)}`, width / 2 + progressWidth / 2 + 18 * unit, progressY + 5 * unit);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(width / 2 - progressWidth / 2, progressY, progressWidth, 3 * unit);
  const progress = frame / Math.max(1, totalFrames - 1);
  const barGrad = ctx.createLinearGradient(width / 2 - progressWidth / 2, 0, width / 2 + progressWidth / 2, 0);
  barGrad.addColorStop(0, "#13b8ff");
  barGrad.addColorStop(0.3, "#7047ff");
  barGrad.addColorStop(0.55, "#f12cbf");
  barGrad.addColorStop(0.78, "#ff6a32");
  barGrad.addColorStop(1, "#ffd44d");
  ctx.fillStyle = barGrad;
  ctx.fillRect(width / 2 - progressWidth / 2, progressY, progressWidth * progress, 3 * unit);

  ctx.fillStyle = cache.vignette;
  ctx.globalAlpha = entrance * outro * 0.85;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export type NativeRenderHandles = {
  kill: () => void;
};

export async function renderNativeVideo(options: {
  analysis: AudioAnalysis;
  title: string;
  artist: string;
  duration: number;
  audioPath: string;
  coverPath: string | null;
  notePath: string;
  settings: RenderSettings;
  outputPath: string;
  job: RenderJob;
  signal?: AbortSignal;
  onProcess?: (child: ChildProcessWithoutNullStreams) => void;
}): Promise<void> {
  const {analysis, title, artist, duration, audioPath, coverPath, notePath, settings, outputPath, job, signal, onProcess} = options;
  assertNotCancelled(signal);

  const {width, height} = settings;
  const totalFrames = Math.max(1, Math.ceil(duration * FPS));
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // Cover is the only scaled bitmap; high quality there, default elsewhere is fine
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const drawCache = buildDrawCache(ctx, width, height);

  let cover: Image | null = null;
  if (coverPath) {
    try {
      cover = await loadImage(coverPath);
    } catch {
      cover = null;
    }
  }
  let noteImage: Image | null = null;
  try {
    noteImage = await loadImage(notePath);
  } catch {
    noteImage = null;
  }

  const encoder = await pickVideoEncoder();
  const beatRipples = extractBeatRipples(analysis);
  job.log.push(`Native encoder: ${encoder} · ${width}x${height} · ${totalFrames} frames @ ${FPS}fps · ${beatRipples.length} beat ripples`);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});

  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    "-threads", "0",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(FPS),
    "-thread_queue_size", "128",
    "-i", "pipe:0",
    "-thread_queue_size", "128",
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    ...videoEncoderArgs(encoder),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", `${settings.audioBitrate}k`,
    "-t", duration.toFixed(6),
    "-movflags", "+faststart",
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    onProcess?.(child);
    // Larger highWaterMark reduces drain stalls between Skia and ffmpeg
    child.stdin.setDefaultEncoding?.("binary" as BufferEncoding);
    let stderr = "";
    let closed = false;
    let writeFailed: Error | null = null;
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) {
        job.log.push(...lines);
        job.log = job.log.slice(-240);
      }
    });
    child.on("error", (error) => {
      writeFailed = error;
      reject(error);
    });
    child.stdin.on("error", (error) => {
      writeFailed = error;
    });

    const fail = (error: unknown) => {
      if (closed) return;
      closed = true;
      try { child.stdin.destroy(); } catch { /* ignore */ }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onAbort = () => fail(new RenderCancelledError());
    signal?.addEventListener("abort", onAbort, {once: true});

    const writeFrame = (buffer: Buffer) => new Promise<void>((res, rej) => {
      if (writeFailed) {
        rej(writeFailed);
        return;
      }
      const ok = child.stdin.write(buffer, (error) => {
        if (error) rej(error);
        else if (ok !== false) res();
      });
      if (ok === false) {
        child.stdin.once("drain", () => res());
      }
    });

    const pump = async () => {
      const progressEvery = Math.max(1, Math.floor(totalFrames / 40));
      // Pipeline: draw frame N+1 while ffmpeg drains frame N
      let pendingWrite: Promise<void> | null = null;
      for (let frame = 0; frame < totalFrames; frame += 1) {
        assertNotCancelled(signal);
        if (writeFailed) throw writeFailed;
        drawFrame(ctx, width, height, analysis, frame, title, artist, cover, noteImage, totalFrames, drawCache, beatRipples);
        // canvas.data() is ~20× faster than getImageData. Copy into a fresh Buffer —
        // the Skia pixel store is reused next frame, and we pipeline the write.
        const buffer = Buffer.from(canvas.data());
        if (frame % progressEvery === 0) {
          job.progress = 24 + Math.round((frame / totalFrames) * 72);
          job.stage = `Encoding frame ${frame + 1}/${totalFrames}`;
        }
        if (pendingWrite) await pendingWrite;
        pendingWrite = writeFrame(buffer);
      }
      if (pendingWrite) await pendingWrite;
      job.progress = 96;
      job.stage = "Finalizing container";
      child.stdin.end();
    };

    void pump().catch(fail);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (closed) return;
      closed = true;
      if (signal?.aborted) {
        reject(new RenderCancelledError());
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split(/\r?\n/).at(-1) || writeFailed?.message || "unknown error"}`));
    });
  });
}

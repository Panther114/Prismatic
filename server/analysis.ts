import {spawn} from "node:child_process";
import {promises as fs} from "node:fs";
import path from "node:path";
import FFT from "fft.js";
import type {AudioAnalysis} from "./types.js";

const SAMPLE_RATE = 22050;
const FFT_SIZE = 1024;
const BAND_COUNT = 32;

function decodeAudio(inputPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ], {windowsHide: true});
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errors).toString("utf8") || `ffmpeg exited with code ${code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const count = Math.floor(buffer.byteLength / 4);
      resolve(new Float32Array(buffer.buffer, buffer.byteOffset, count));
    });
  });
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 1;
};

export async function analyzeAudio(
  inputPath: string,
  duration: number,
  cachePath: string,
  fps = 30,
): Promise<AudioAnalysis> {
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as AudioAnalysis;
    if (cached.fps === fps && Math.abs(cached.duration - duration) < 0.01 && cached.bands === BAND_COUNT) return cached;
  } catch {
    // Cache miss is expected for new tracks.
  }

  const samples = await decodeAudio(inputPath);
  const fft = new FFT(FFT_SIZE);
  const spectrum = fft.createComplexArray();
  const windowed = new Array<number>(FFT_SIZE).fill(0);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const rawFrames: number[][] = [];
  const previous = new Array<number>(BAND_COUNT).fill(0);
  const minFrequency = 32;
  const maxFrequency = SAMPLE_RATE / 2;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const center = Math.floor((frame / fps) * SAMPLE_RATE);
    const start = center - Math.floor(FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = samples[start + i] || 0;
      windowed[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }
    fft.realTransform(spectrum, windowed);
    const bands = new Array<number>(BAND_COUNT).fill(0);
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const low = minFrequency * Math.pow(maxFrequency / minFrequency, band / BAND_COUNT);
      const high = minFrequency * Math.pow(maxFrequency / minFrequency, (band + 1) / BAND_COUNT);
      const lowBin = Math.max(1, Math.floor((low * FFT_SIZE) / SAMPLE_RATE));
      const highBin = Math.max(lowBin + 1, Math.ceil((high * FFT_SIZE) / SAMPLE_RATE));
      let sum = 0;
      for (let bin = lowBin; bin < highBin && bin < FFT_SIZE / 2; bin += 1) {
        const real = spectrum[2 * bin];
        const imaginary = spectrum[2 * bin + 1];
        sum += Math.sqrt(real * real + imaginary * imaginary);
      }
      const magnitude = Math.log1p((sum / Math.max(1, highBin - lowBin)) * 8);
      const smoothed = previous[band] * (magnitude > previous[band] ? 0.38 : 0.72) + magnitude * (magnitude > previous[band] ? 0.62 : 0.28);
      previous[band] = smoothed;
      bands[band] = smoothed;
    }
    rawFrames.push(bands);
  }

  const ceilings = Array.from({length: BAND_COUNT}, (_, band) => quantile(rawFrames.map((frame) => frame[band]), 0.985));
  let previousEnergy = 0;
  const frames = rawFrames.map((raw) => {
    const bands = raw.map((value, index) => Math.min(1, Math.pow(value / Math.max(0.0001, ceilings[index]), 0.82)));
    const mean = (start: number, end: number) => bands.slice(start, end).reduce((sum, value) => sum + value, 0) / (end - start);
    const bass = mean(0, 7);
    const mid = mean(7, 20);
    const treble = mean(20, 32);
    const energy = bass * 0.48 + mid * 0.34 + treble * 0.18;
    const peak = Math.max(0, Math.min(1, (energy - previousEnergy) * 5.2));
    previousEnergy = energy;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {bands: bands.map(round), energy: round(energy), bass: round(bass), mid: round(mid), treble: round(treble), peak: round(peak)};
  });

  const analysis: AudioAnalysis = {fps, duration, totalFrames, bands: BAND_COUNT, frames};
  await fs.mkdir(path.dirname(cachePath), {recursive: true});
  await fs.writeFile(cachePath, JSON.stringify(analysis), "utf8");
  return analysis;
}

export function resampleAnalysis(analysis: AudioAnalysis, fps: number): AudioAnalysis {
  if (fps === analysis.fps) return analysis;
  const totalFrames = Math.max(1, Math.ceil(analysis.duration * fps));
  const frames = Array.from({length: totalFrames}, (_, frame) =>
    analysis.frames[Math.min(analysis.frames.length - 1, Math.floor((frame / fps) * analysis.fps))],
  );
  return {...analysis, fps, totalFrames, frames};
}

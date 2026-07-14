/** Offline spectral analysis in the browser (no server, no ffmpeg). */

export type AnalysisFrame = {
  bins: Float32Array;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  peak: number;
};

export type ClientAnalysis = {
  fps: number;
  duration: number;
  totalFrames: number;
  frames: AnalysisFrame[];
  /** Decoded PCM for audio mux (mono float -1..1), sampleRate Hz */
  pcm: Float32Array;
  sampleRate: number;
};

const FFT_SIZE = 1024;
const BIN_COUNT = 96;
const ANALYSIS_RATE = 22050;

function nextPow2(n: number) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 FFT (real input → complex interleaved spectrum). */
function fftReal(input: Float32Array): Float32Array {
  const n = input.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    out[i * 2] = input[i];
    out[i * 2 + 1] = 0;
  }
  // Bit reverse
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ri = i * 2;
      const rj = j * 2;
      const tr = out[ri];
      const ti = out[ri + 1];
      out[ri] = out[rj];
      out[ri + 1] = out[rj + 1];
      out[rj] = tr;
      out[rj + 1] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenR = Math.cos(ang);
    const wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const u = (i + j) * 2;
        const v = (i + j + len / 2) * 2;
        const ur = out[u];
        const ui = out[u + 1];
        const vr = out[v] * wr - out[v + 1] * wi;
        const vi = out[v] * wi + out[v + 1] * wr;
        out[u] = ur + vr;
        out[u + 1] = ui + vi;
        out[v] = ur - vr;
        out[v + 1] = ui - vi;
        const nwr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nwr;
      }
    }
  }
  return out;
}

function downsampleMono(buffer: AudioBuffer, targetRate: number): Float32Array {
  const channels = buffer.numberOfChannels;
  const srcRate = buffer.sampleRate;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }
  if (Math.abs(srcRate - targetRate) < 1) return mono;
  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(length - 1, i0 + 1);
    const t = src - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return out;
}

function average(values: Float32Array, start: number, end: number) {
  let total = 0;
  const a = Math.max(0, start);
  const b = Math.min(values.length, end);
  for (let i = a; i < b; i += 1) total += values[i] || 0;
  return total / Math.max(1, b - a);
}

/**
 * Decode audio from a URL (blob: or same-origin) and build per-frame spectrum
 * for offline visualizer export.
 */
export async function analyzeAudioForExport(
  mediaUrl: string,
  fps = 30,
  onProgress?: (progress: number, stage: string) => void,
  signal?: AbortSignal,
): Promise<ClientAnalysis> {
  onProgress?.(2, "Downloading audio for offline encode…");
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`Could not load audio (${response.status})`);
  const raw = await response.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

  onProgress?.(8, "Decoding audio…");
  const ctx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(raw.slice(0));
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const duration = audioBuffer.duration || 0;
  const samples = downsampleMono(audioBuffer, ANALYSIS_RATE);
  // Full-rate mono for mux (prefer original rate, mono mix)
  const pcm = downsampleMono(audioBuffer, audioBuffer.sampleRate);
  const sampleRate = audioBuffer.sampleRate;

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const n = nextPow2(FFT_SIZE);
  const windowed = new Float32Array(n);
  const previous = new Float32Array(BIN_COUNT);
  const rawFrames: Float32Array[] = [];

  onProgress?.(12, "Analyzing spectrum…");
  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (frame % 60 === 0) {
      onProgress?.(12 + Math.round((frame / totalFrames) * 28), `Analyzing · frame ${frame}/${totalFrames}`);
      // Keep UI responsive
      await new Promise((r) => setTimeout(r, 0));
    }
    const center = Math.floor((frame / fps) * ANALYSIS_RATE);
    const start = center - Math.floor(FFT_SIZE / 2);
    for (let i = 0; i < n; i += 1) {
      const sample = i < FFT_SIZE ? (samples[start + i] || 0) : 0;
      const w = i < FFT_SIZE ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)) : 0;
      windowed[i] = sample * w;
    }
    const spectrum = fftReal(windowed);
    const bins = new Float32Array(BIN_COUNT);
    const freqLen = n / 2;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      // Match live visualizer mapping (power curve into spectrum)
      const source = Math.floor(Math.pow(i / BIN_COUNT, 1.55) * freqLen * 0.72);
      const bin = Math.min(freqLen - 1, source);
      const re = spectrum[bin * 2];
      const im = spectrum[bin * 2 + 1];
      const mag = Math.log1p(Math.sqrt(re * re + im * im) * 8);
      const prev = previous[i];
      const smoothed = prev * (mag > prev ? 0.34 : 0.82) + mag * (mag > prev ? 0.66 : 0.18);
      previous[i] = smoothed;
      bins[i] = smoothed;
    }
    rawFrames.push(bins);
  }

  // Normalize like live smoothing ceilings
  const ceilings = new Float32Array(BIN_COUNT);
  for (let b = 0; b < BIN_COUNT; b += 1) {
    const values: number[] = [];
    for (let f = 0; f < rawFrames.length; f += 1) values.push(rawFrames[f][b]);
    values.sort((a, c) => a - c);
    ceilings[b] = values[Math.min(values.length - 1, Math.floor(values.length * 0.985))] || 1;
  }

  let prevEnergy = 0;
  const frames: AnalysisFrame[] = rawFrames.map((raw) => {
    const bins = new Float32Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i += 1) {
      bins[i] = Math.min(1, Math.pow(raw[i] / Math.max(0.0001, ceilings[i]), 0.82));
    }
    const bass = average(bins, 0, 14);
    const mid = average(bins, 18, 57);
    const treble = average(bins, 60, 96);
    const energy = bass * 0.4 + mid * 0.38 + treble * 0.22;
    const peak = Math.min(1, Math.max(0, (energy - prevEnergy) * 5.2 + energy * 0.18));
    prevEnergy = prevEnergy * 0.72 + energy * 0.28;
    return {bins, bass, mid, treble, energy, peak};
  });

  onProgress?.(42, "Spectrum ready");
  return {fps, duration, totalFrames, frames, pcm, sampleRate};
}

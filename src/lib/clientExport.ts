/**
 * Browser-side video export — all encoding on the user's machine.
 *
 * Primary path: offline WebCodecs (analyze → draw frames → encode) as fast
 * as the device allows (often many× real-time).
 * Fallback: MediaRecorder realtime capture when WebCodecs is unavailable.
 */

import {analyzeAudioForExport} from "./clientAnalysis";
import {createRippleState, drawExportFrame, tickRipples} from "./exportDraw";
import {WebmMuxer} from "./webmMuxer";

export type ClientExportOptions = {
  /** Same-origin or blob: URL of the track audio */
  mediaUrl: string;
  width: number;
  height: number;
  fileName: string;
  fps?: number;
  audioBitrateKbps?: number;
  /** Optional live elements for MediaRecorder fallback */
  canvas?: HTMLCanvasElement | null;
  audio?: HTMLAudioElement | null;
  audioStream?: MediaStream;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
};

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return url;
}

function supportsWebCodecs() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

async function waitForEncoder(encoder: {encodeQueueSize: number}, max = 8) {
  while (encoder.encodeQueueSize > max) {
    await new Promise((r) => setTimeout(r, 4));
  }
}

async function configureVideoEncoder(
  encoder: VideoEncoder,
  width: number,
  height: number,
  bitrate: number,
): Promise<"V_VP9" | "V_VP8"> {
  const candidates: Array<{codec: string; mux: "V_VP9" | "V_VP8"}> = [
    {codec: "vp09.00.10.08", mux: "V_VP9"},
    {codec: "vp09.00.20.08", mux: "V_VP9"},
    {codec: "vp8", mux: "V_VP8"},
  ];
  let lastError: unknown;
  for (const c of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        bitrate,
        framerate: 30,
        avc: undefined,
      });
      if (!support.supported) continue;
      encoder.configure({
        codec: c.codec,
        width,
        height,
        bitrate,
        framerate: 30,
        latencyMode: "quality",
      });
      return c.mux;
    } catch (error) {
      lastError = error;
    }
  }
  // Last resort: configure without isConfigSupported
  try {
    encoder.configure({codec: "vp8", width, height, bitrate, framerate: 30});
    return "V_VP8";
  } catch {
    throw lastError instanceof Error ? lastError : new Error("No WebCodecs video encoder available");
  }
}

function even(n: number) {
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Offline export: spectrum analysis + canvas draw + WebCodecs, faster than real-time.
 */
async function exportOfflineWebCodecs(options: ClientExportOptions): Promise<{blob: Blob; objectUrl: string; fileName: string}> {
  const {
    mediaUrl,
    width: rawW,
    height: rawH,
    fileName,
    fps = 30,
    audioBitrateKbps = 256,
    onProgress,
    signal,
  } = options;

  const width = even(Math.max(2, rawW));
  const height = even(Math.max(2, rawH));
  const videoBitrate = width >= 3000 ? 24_000_000 : width >= 1600 ? 12_000_000 : 6_000_000;

  const analysis = await analyzeAudioForExport(mediaUrl, fps, onProgress, signal);
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

  onProgress?.(44, "Setting up offline encoder…");

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), {width, height});
  if ("width" in canvas) {
    (canvas as HTMLCanvasElement | OffscreenCanvas).width = width;
    (canvas as HTMLCanvasElement | OffscreenCanvas).height = height;
  }
  const ctx = (canvas as OffscreenCanvas).getContext("2d", {alpha: false}) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Could not create export canvas");

  let pendingVideo: EncodedVideoChunk[] = [];
  let pendingAudio: EncodedAudioChunk[] = [];
  let muxer: WebmMuxer | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk) => {
      if (muxer) muxer.addVideoChunk(chunk);
      else pendingVideo.push(chunk);
    },
    error: (e) => console.error("VideoEncoder", e),
  });
  const videoMuxCodec = await configureVideoEncoder(videoEncoder, width, height, videoBitrate);

  let audioEncoder: AudioEncoder | null = null;
  let audioSampleRate = 48000;
  let hasAudio = false;
  if (typeof AudioEncoder !== "undefined") {
    audioEncoder = new AudioEncoder({
      output: (chunk) => {
        if (muxer) muxer.addAudioChunk(chunk);
        else pendingAudio.push(chunk);
      },
      error: (e) => console.error("AudioEncoder", e),
    });
    try {
      const audioConfig: AudioEncoderConfig = {
        codec: "opus",
        sampleRate: audioSampleRate,
        numberOfChannels: 1,
        bitrate: Math.max(96_000, Math.min(320_000, audioBitrateKbps * 1000)),
      };
      const support = await AudioEncoder.isConfigSupported(audioConfig);
      if (support.supported) {
        audioEncoder.configure(audioConfig);
        hasAudio = true;
      } else {
        audioEncoder.close();
        audioEncoder = null;
      }
    } catch {
      try { audioEncoder?.close(); } catch { /* ignore */ }
      audioEncoder = null;
    }
  }

  muxer = new WebmMuxer({
    width,
    height,
    frameRate: fps,
    videoCodec: videoMuxCodec,
    sampleRate: audioSampleRate,
    audioChannels: 1,
    hasAudio,
  });
  for (const chunk of pendingVideo) muxer.addVideoChunk(chunk);
  for (const chunk of pendingAudio) muxer.addAudioChunk(chunk);
  pendingVideo = [];
  pendingAudio = [];

  // Encode audio first (or interleaved) — resample PCM → 48k mono
  if (audioEncoder) {
    onProgress?.(46, "Encoding audio…");
    const src = analysis.pcm;
    const srcRate = analysis.sampleRate;
    const ratio = srcRate / audioSampleRate;
    const outLen = Math.max(1, Math.floor(src.length / ratio));
    const resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const s = i * ratio;
      const i0 = Math.floor(s);
      const i1 = Math.min(src.length - 1, i0 + 1);
      const t = s - i0;
      resampled[i] = src[i0] * (1 - t) + src[i1] * t;
    }
    const frameSize = 960; // 20ms @ 48k
    for (let offset = 0, frameIndex = 0; offset < resampled.length; offset += frameSize, frameIndex += 1) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      const slice = resampled.subarray(offset, Math.min(resampled.length, offset + frameSize));
      if (slice.length < 64) break;
      const data = slice.length === frameSize ? slice : (() => {
        const pad = new Float32Array(frameSize);
        pad.set(slice);
        return pad;
      })();
      const timestamp = Math.round((frameIndex * frameSize / audioSampleRate) * 1_000_000);
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: audioSampleRate,
        numberOfFrames: frameSize,
        numberOfChannels: 1,
        timestamp,
        data,
      });
      await waitForEncoder(audioEncoder, 16);
      audioEncoder.encode(audioData);
      audioData.close();
      if (frameIndex % 50 === 0) {
        onProgress?.(46 + Math.round((offset / resampled.length) * 8), "Encoding audio…");
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  const rippleState = createRippleState();
  const total = analysis.totalFrames;
  onProgress?.(55, "Rendering frames offline…");

  for (let frame = 0; frame < total; frame += 1) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    const audioFrame = analysis.frames[frame];
    const nowMs = (frame / fps) * 1000;
    tickRipples(rippleState, audioFrame, nowMs);
    drawExportFrame(ctx, width, height, audioFrame, nowMs, rippleState.ripples);

    const timestamp = Math.round((frame / fps) * 1_000_000);
    const videoFrame = new VideoFrame(canvas as CanvasImageSource, {
      timestamp,
      duration: Math.round(1_000_000 / fps),
    });
    await waitForEncoder(videoEncoder, 6);
    videoEncoder.encode(videoFrame, {keyFrame: frame % (fps * 2) === 0});
    videoFrame.close();

    if (frame % 8 === 0) {
      const p = 55 + Math.round((frame / total) * 42);
      onProgress?.(p, `Offline encode · ${frame}/${total} frames`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress?.(97, "Finalizing…");
  await videoEncoder.flush();
  videoEncoder.close();

  const blob = muxer!.finalize();
  const safeName = fileName.replace(/\.(mp4|webm)$/i, "") + ".webm";
  const objectUrl = downloadBlob(blob, safeName);
  onProgress?.(100, "Export complete (offline)");
  return {blob, objectUrl, fileName: safeName};
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/** Realtime fallback when WebCodecs is missing. */
async function exportRealtimeMediaRecorder(options: ClientExportOptions): Promise<{blob: Blob; objectUrl: string; fileName: string}> {
  const {canvas, audio, audioStream, fileName, fps = 30, audioBitrateKbps = 256, onProgress, signal} = options;
  if (!canvas || !audio) throw new Error("Realtime export needs canvas + audio element");
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser — try Chrome or Edge.");
  }
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("No supported MediaRecorder video codec found.");

  onProgress?.(1, "Realtime fallback encode…");
  const videoStream = canvas.captureStream(fps);
  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) tracks.push(track);
  }

  const combined = new MediaStream(tracks);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(combined, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: Math.max(96_000, Math.min(320_000, audioBitrateKbps * 1000)),
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("MediaRecorder failed"));
    recorder.onstop = () => resolve(new Blob(chunks, {type: "video/webm"}));
  });

  const onAbort = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch { /* ignore */ }
    audio.pause();
  };
  signal?.addEventListener("abort", onAbort, {once: true});

  const duration = Math.max(0.1, audio.duration || 0);
  audio.currentTime = 0;
  recorder.start(250);
  await audio.play();

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) {
        reject(new DOMException("Export cancelled", "AbortError"));
        return;
      }
      const t = audio.currentTime;
      onProgress?.(Math.min(99, Math.round((t / duration) * 98) + 1), `Realtime · ${Math.floor(t)}s / ${Math.floor(duration)}s`);
      if (audio.ended || t >= duration - 0.05) {
        resolve();
        return;
      }
      window.setTimeout(tick, 200);
    };
    audio.addEventListener("ended", () => resolve(), {once: true});
    tick();
  });

  audio.pause();
  if (recorder.state !== "inactive") recorder.stop();
  const blob = await stopped;
  signal?.removeEventListener("abort", onAbort);
  for (const track of videoStream.getTracks()) track.stop();

  const safeName = fileName.replace(/\.(mp4|webm)$/i, "") + ".webm";
  const objectUrl = downloadBlob(blob, safeName);
  onProgress?.(100, "Export complete");
  return {blob, objectUrl, fileName: safeName};
}

/**
 * Export visualizer video in the browser.
 * Prefers offline WebCodecs (faster than real-time); falls back to MediaRecorder.
 */
export async function exportClientVideo(options: ClientExportOptions): Promise<{blob: Blob; objectUrl: string; fileName: string}> {
  if (supportsWebCodecs() && options.mediaUrl) {
    try {
      return await exportOfflineWebCodecs(options);
    } catch (error) {
      if ((error as {name?: string}).name === "AbortError") throw error;
      console.warn("Offline WebCodecs export failed, trying realtime fallback", error);
      if (options.canvas && options.audio) {
        options.onProgress?.(1, "Offline encode failed — realtime fallback…");
        return exportRealtimeMediaRecorder(options);
      }
      throw error;
    }
  }
  return exportRealtimeMediaRecorder(options);
}


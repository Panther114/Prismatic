/**
 * Browser-side video export — all encoding happens on the user's machine.
 * Server never receives audio bytes or runs canvas/ffmpeg for masters.
 */

export type ClientExportOptions = {
  canvas: HTMLCanvasElement;
  audio: HTMLAudioElement;
  /** Optional dedicated record bus (preferred so mic-level routing is clean). */
  audioStream?: MediaStream;
  fileName: string;
  fps?: number;
  /** Target audio bitrate in kbps (browser may approximate). */
  audioBitrateKbps?: number;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
};

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

/**
 * Records the live visualizer canvas + track audio in the browser and
 * downloads the result. Runs at (approx) real-time playback speed.
 */
export async function exportClientVideo(options: ClientExportOptions): Promise<{blob: Blob; objectUrl: string; fileName: string}> {
  const {canvas, audio, audioStream, fileName, fps = 30, audioBitrateKbps = 256, onProgress, signal} = options;
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser — try Chrome, Edge, or Firefox.");
  }
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("No supported MediaRecorder video codec found in this browser.");

  const videoStream = canvas.captureStream(fps);
  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) tracks.push(track);
  } else if ("captureStream" in audio && typeof (audio as HTMLAudioElement & {captureStream?: () => MediaStream}).captureStream === "function") {
    const captured = (audio as HTMLAudioElement & {captureStream: () => MediaStream}).captureStream();
    for (const track of captured.getAudioTracks()) tracks.push(track);
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
    recorder.onstop = () => resolve(new Blob(chunks, {type: mimeType.includes("mp4") ? "video/mp4" : "video/webm"}));
  });

  const onAbort = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
    audio.pause();
  };
  signal?.addEventListener("abort", onAbort, {once: true});

  const duration = Math.max(0.1, audio.duration || 0);
  audio.currentTime = 0;
  onProgress?.(1, "Starting browser encode…");

  recorder.start(250);
  try {
    await audio.play();
  } catch (error) {
    onAbort();
    throw error instanceof Error ? error : new Error(String(error));
  }

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) {
        reject(new DOMException("Export cancelled", "AbortError"));
        return;
      }
      const t = audio.currentTime;
      const progress = Math.min(99, Math.round((t / duration) * 98) + 1);
      onProgress?.(progress, `Recording in browser · ${Math.floor(t)}s / ${Math.floor(duration)}s`);
      if (audio.ended || t >= duration - 0.05) {
        resolve();
        return;
      }
      window.setTimeout(tick, 200);
    };
    audio.addEventListener("ended", () => resolve(), {once: true});
    tick();
  });

  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

  audio.pause();
  onProgress?.(99, "Finalizing download…");
  if (recorder.state !== "inactive") recorder.stop();
  const blob = await stopped;
  signal?.removeEventListener("abort", onAbort);

  for (const track of videoStream.getTracks()) track.stop();

  const safeName = fileName.replace(/\.mp4$/i, mimeType.includes("mp4") ? ".mp4" : ".webm");
  const objectUrl = downloadBlob(blob, safeName);
  onProgress?.(100, "Export complete");
  return {blob, objectUrl, fileName: safeName};
}

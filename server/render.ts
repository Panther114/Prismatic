import {type ChildProcess} from "node:child_process";
import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import type {MusicLibrary} from "./library.js";
import {analyzeAudio} from "./analysis.js";
import {RenderCancelledError, renderNativeVideo} from "./native-render.js";
import type {RenderJob, RenderSettings, ResolutionPreset} from "./types.js";

const RESOLUTIONS: Record<ResolutionPreset, {width: number; height: number}> = {
  "720p": {width: 1280, height: 720},
  "1080p": {width: 1920, height: 1080},
  "4k": {width: 3840, height: 2160},
  square: {width: 1080, height: 1080},
  portrait: {width: 1080, height: 1920},
};
const AUDIO_BITRATES = new Set([128, 192, 256, 320]);

/** "Under tale" → "Under_tale" */
function safeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "track";
}

async function uniqueVisualsName(outputDirectory: string, title: string) {
  const base = `${safeName(title)}_Visuals`;
  let candidate = `${base}.mp4`;
  let n = 2;
  while (true) {
    try {
      await fs.access(path.join(outputDirectory, candidate));
      candidate = `${base}_${n}.mp4`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}

function isActiveStatus(status: RenderJob["status"]) {
  return status === "queued" || status === "analyzing" || status === "rendering";
}

function coverExtension(mime: string) {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  return ".jpg";
}

type JobRuntime = {
  controller: AbortController;
  children: Set<ChildProcess>;
};

export class RenderManager {
  readonly jobs = new Map<string, RenderJob>();
  private readonly runtime = new Map<string, JobRuntime>();

  constructor(
    private readonly root: string,
    private readonly library: MusicLibrary,
    private readonly stateDirectory: string,
    private readonly outputDirectory: string,
  ) {}

  async create(trackId: string, requestedResolution: string, requestedAudioBitrate: number) {
    const track = await this.library.get(trackId);
    if (!track) throw new Error("Track not found");
    if (!(requestedResolution in RESOLUTIONS)) throw new Error("Unsupported resolution");
    if (!AUDIO_BITRATES.has(requestedAudioBitrate)) throw new Error("Unsupported audio bitrate");
    if ([...this.jobs.values()].some((job) => job.trackId === trackId && isActiveStatus(job.status))) {
      throw new Error("A render is already running for this track — cancel it first");
    }
    const resolution = requestedResolution as ResolutionPreset;
    const settings: RenderSettings = {
      resolution,
      ...RESOLUTIONS[resolution],
      audioBitrate: requestedAudioBitrate as RenderSettings["audioBitrate"],
    };
    const id = randomUUID().slice(0, 8);
    const job: RenderJob = {
      id,
      trackId,
      trackTitle: track.title,
      settings,
      status: "queued",
      stage: "Queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      outputs: [],
      log: [],
    };
    this.jobs.set(id, job);
    const controller = new AbortController();
    this.runtime.set(id, {controller, children: new Set()});
    void this.execute(job).catch((error: unknown) => {
      if (job.status === "cancelled" || error instanceof RenderCancelledError) {
        job.status = "cancelled";
        job.stage = "Cancelled";
        job.error = undefined;
        return;
      }
      job.status = "failed";
      job.stage = "Render failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.log.push(job.error);
    }).finally(() => {
      this.runtime.delete(id);
    });
    return job;
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!isActiveStatus(job.status)) return job;
    job.status = "cancelled";
    job.stage = "Cancelling…";
    job.error = undefined;
    const runtime = this.runtime.get(jobId);
    if (runtime) {
      runtime.controller.abort();
      for (const child of runtime.children) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
      runtime.children.clear();
    }
    job.stage = "Cancelled";
    return job;
  }

  private registerChild(jobId: string, child: ChildProcess) {
    const runtime = this.runtime.get(jobId);
    if (!runtime) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      return;
    }
    runtime.children.add(child);
    child.on("close", () => runtime.children.delete(child));
  }

  private signal(jobId: string) {
    return this.runtime.get(jobId)?.controller.signal;
  }

  private async execute(job: RenderJob) {
    const signal = this.signal(job.id);
    if (!signal) throw new RenderCancelledError();
    const track = await this.library.get(job.trackId);
    if (!track) throw new Error("Track disappeared from the music folder");
    const audioPath = this.library.absolutePath(track);
    const jobDirectory = path.join(this.stateDirectory, "jobs", job.id);
    const cachePath = path.join(this.stateDirectory, "cache", `${track.id}-30fps.json`);
    await fs.mkdir(jobDirectory, {recursive: true});
    await fs.mkdir(this.outputDirectory, {recursive: true});

    job.status = "analyzing";
    job.stage = "Extracting frequency architecture";
    job.progress = 8;
    if (signal.aborted) throw new RenderCancelledError();
    const analysis = await analyzeAudio(audioPath, track.duration, cachePath, 30);
    if (signal.aborted) throw new RenderCancelledError();
    job.progress = 22;

    job.status = "rendering";
    job.stage = "Rendering video";
    job.progress = 24;
    const cover = await this.library.cover(track);
    const fileName = await uniqueVisualsName(this.outputDirectory, track.title);
    const finalPath = path.join(this.outputDirectory, fileName);
    const coverPath = cover
      ? path.join(jobDirectory, `cover${coverExtension(cover.mime)}`)
      : null;
    if (cover && coverPath) await fs.writeFile(coverPath, cover.data);

    await renderNativeVideo({
      analysis,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      audioPath,
      coverPath,
      notePath: path.join(this.root, "public", "music-note.png"),
      settings: job.settings,
      outputPath: finalPath,
      job,
      signal,
      onProcess: (child) => this.registerChild(job.id, child),
    });

    if (signal.aborted) throw new RenderCancelledError();
    job.outputs.push({fileName, url: `/outputs/${encodeURIComponent(fileName)}`});
    job.status = "complete";
    job.stage = "Render complete";
    job.progress = 100;
  }
}

import path from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as wait} from "node:timers/promises";
import {MusicLibrary} from "../server/library.js";
import {RenderManager} from "../server/render.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, ".prismatic");
const library = new MusicLibrary(root, path.join(root, "music"), state);
const manager = new RenderManager(root, library, state, path.join(root, "output"));
const track = (await library.list())[0];
if (!track) throw new Error("No track found in music/");
const job = await manager.create(track.id, "1080p", 320);
let lastStage = "";
while (job.status !== "complete" && job.status !== "failed" && job.status !== "cancelled") {
  if (job.stage !== lastStage) {
    console.log(`[${job.progress}%] ${job.stage}`);
    lastStage = job.stage;
  }
  await wait(800);
}
if (job.status === "failed" || job.status === "cancelled") {
  console.error(job.log.join("\n"));
  throw new Error(job.error || (job.status === "cancelled" ? "Render cancelled" : "Render failed"));
}
console.log("Rendered:");
job.outputs.forEach((output) => console.log(`- ${path.join(root, "output", output.fileName)}`));

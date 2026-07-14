import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {MusicLibrary} from "../server/library.js";
import {analyzeAudio, resampleAnalysis} from "../server/analysis.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = path.join(root, ".prismatic");
const library = new MusicLibrary(root, path.join(root, "music"), stateDirectory);
const tracks = await library.list();
const track = tracks.find((item) => item.title === "A Thousand Years") || tracks[0];
if (!track) throw new Error("No audio file found under music/");
const audioPath = library.absolutePath(track);
const analysis = await analyzeAudio(audioPath, track.duration, path.join(stateDirectory, "cache", `${track.id}-30fps.json`), 30);
const cover = await library.cover(track);

const remotionDirectory = path.join(root, "remotion", "public", "generated", "sample");
const hyperframesDirectory = path.join(root, "hyperframes", "assets");
const hyperframesFonts = path.join(hyperframesDirectory, "fonts");
await Promise.all([fs.mkdir(remotionDirectory, {recursive: true}), fs.mkdir(hyperframesFonts, {recursive: true})]);
await Promise.all([
  fs.copyFile(audioPath, path.join(remotionDirectory, "audio.mp3")),
  fs.copyFile(audioPath, path.join(hyperframesDirectory, "audio.mp3")),
  fs.writeFile(path.join(remotionDirectory, "analysis.json"), JSON.stringify(analysis), "utf8"),
  ...(cover ? [fs.writeFile(path.join(remotionDirectory, "cover.jpg"), cover.data), fs.writeFile(path.join(hyperframesDirectory, "cover.jpg"), cover.data)] : []),
  fs.writeFile(path.join(hyperframesDirectory, "runtime.js"), `window.PRISMATIC=${JSON.stringify({title: track.title, artist: track.artist, coverSrc: cover ? "assets/cover.jpg" : null})};window.AUDIO_DATA=${JSON.stringify(resampleAnalysis(analysis, 15))};`, "utf8"),
  fs.copyFile(path.join(root, "node_modules", "@fontsource", "barlow-condensed", "files", "barlow-condensed-latin-700-normal.woff2"), path.join(hyperframesFonts, "barlow-condensed-700.woff2")),
  fs.copyFile(path.join(root, "node_modules", "@fontsource", "ibm-plex-sans", "files", "ibm-plex-sans-latin-300-normal.woff2"), path.join(hyperframesFonts, "ibm-plex-sans-300.woff2")),
  fs.copyFile(path.join(root, "node_modules", "@fontsource", "ibm-plex-sans", "files", "ibm-plex-sans-latin-400-normal.woff2"), path.join(hyperframesFonts, "ibm-plex-sans-400.woff2")),
  fs.copyFile(path.join(root, "node_modules", "@fontsource", "jetbrains-mono", "files", "jetbrains-mono-latin-400-normal.woff2"), path.join(hyperframesFonts, "jetbrains-mono-400.woff2")),
  fs.copyFile(path.join(root, "hyperframes", "node_modules", "gsap", "dist", "gsap.min.js"), path.join(hyperframesDirectory, "gsap.min.js")),
]);
console.log(`Prepared ${analysis.totalFrames} audio-reactive frames for ${track.title}.`);

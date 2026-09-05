import {describe, expect, it} from "vitest";
import type {Track} from "../types";
import {bitrateKbps, formatBitrate, isLowQualityBitrate, sortTracks} from "./LibraryView";

const track = (id: string, values: Partial<Track> = {}): Track => ({
  id,
  sourceId: id,
  fileName: `${id}.mp3`,
  relativePath: `${id}.mp3`,
  folder: "",
  mediaUrl: "",
  coverUrl: "/music-note.svg",
  waveformUrl: "",
  title: id,
  artist: "Artist",
  album: "Album",
  duration: 100,
  bitrate: 320,
  format: "mp3",
  ...values,
});

describe("library table sorting", () => {
  it("sorts text columns in both directions without mutating the input", () => {
    const tracks = [track("Bravo"), track("alpha"), track("Charlie")];
    expect(sortTracks(tracks, "title").map(({title}) => title)).toEqual(["alpha", "Bravo", "Charlie"]);
    expect(sortTracks(tracks, "title", "desc").map(({title}) => title)).toEqual(["Charlie", "Bravo", "alpha"]);
    expect(tracks.map(({title}) => title)).toEqual(["Bravo", "alpha", "Charlie"]);
  });

  it("sorts bitrate numerically and keeps unknown metadata last", () => {
    const tracks = [track("unknown", {bitrate: null}), track("high", {bitrate: 320000}), track("low", {bitrate: 128})];
    expect(sortTracks(tracks, "bitrate").map(({id}) => id)).toEqual(["low", "high", "unknown"]);
    expect(sortTracks(tracks, "bitrate", "desc").map(({id}) => id)).toEqual(["high", "low", "unknown"]);
  });
});

describe("library bitrate display", () => {
  it("normalizes bits/second and kbps metadata", () => {
    expect(bitrateKbps(320000)).toBe(320);
    expect(bitrateKbps(320)).toBe(320);
    expect(formatBitrate(128000)).toBe("128 kbps");
    expect(formatBitrate(null)).toBeNull();
  });

  it("highlights only known bitrates below 320 kbps", () => {
    expect(isLowQualityBitrate(319000)).toBe(true);
    expect(isLowQualityBitrate(319)).toBe(true);
    expect(isLowQualityBitrate(320000)).toBe(false);
    expect(isLowQualityBitrate(null)).toBe(false);
  });
});

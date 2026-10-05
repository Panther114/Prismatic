import {describe, expect, it} from "vitest";
import {orderByIds, selectRange} from "./LibraryView";
import {formatTotalDuration, moveTrackId} from "./PlaylistView";
import type {Track} from "../types";

const track = (id: string): Track => ({
  id, sourceId: "music", fileName: `${id}.mp3`, relativePath: `${id}.mp3`, folder: "", mediaUrl: "", coverUrl: "",
  waveformUrl: "", title: id, artist: "", album: "", duration: 1, bitrate: null, format: "MP3",
});
const list = ["a", "b", "c", "d", "e"].map(track);

describe("selectRange", () => {
  it("is inclusive and direction-agnostic", () => {
    expect(selectRange(list, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(list, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("handles unknown anchors", () => {
    expect(selectRange(list, "zzz", "c")).toEqual(["c"]);
    expect(selectRange(list, "a", "zzz")).toEqual([]);
  });
});

describe("orderByIds", () => {
  it("keeps the requested order and drops missing tracks", () => {
    expect(orderByIds(list, ["c", "x", "a"]).map((t) => t.id)).toEqual(["c", "a"]);
  });
});

describe("moveTrackId", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves down and up to the target position", () => {
    expect(moveTrackId(ids, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveTrackId(ids, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });
  it("returns the same array when nothing changes", () => {
    expect(moveTrackId(ids, "b", "b")).toBe(ids);
    expect(moveTrackId(ids, "x", "b")).toBe(ids);
  });
});

describe("formatTotalDuration", () => {
  it("switches to hours for long playlists", () => {
    expect(formatTotalDuration(125)).toBe("2:05");
    expect(formatTotalDuration(3600)).toBe("1 hr 0 min");
    expect(formatTotalDuration(7500)).toBe("2 hr 5 min");
    expect(formatTotalDuration(7190)).toBe("2 hr");
  });
});

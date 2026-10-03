import {describe, expect, it} from "vitest";
import type {Track} from "../types";
import {filterPlaylistTracks, sortPlaylistTracks, toggleTrackMembership} from "./PlaylistView";

const makeTrack = (id: string, title: string, artist: string, album: string, duration: number): Track => ({
  id,
  sourceId: "source",
  fileName: `${id}.mp3`,
  relativePath: `${id}.mp3`,
  folder: "",
  mediaUrl: "",
  coverUrl: "/music-note.svg",
  waveformUrl: "",
  title,
  artist,
  album,
  duration,
  bitrate: null,
  format: "mp3",
});

describe("playlist membership", () => {
  it("adds a library track to the end of a playlist", () => {
    expect(toggleTrackMembership(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removes an included track without disturbing order", () => {
    expect(toggleTrackMembership(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("searches a playlist by title, artist, or album and skips missing tracks", () => {
    const tracks = [
      makeTrack("a", "Blue Hour", "Mira", "Night Signals", 180),
      makeTrack("b", "Northbound", "Jun", "Blue Lines", 210),
    ];
    const byId = new Map(tracks.map((track) => [track.id, track]));

    expect(filterPlaylistTracks(["a", "missing", "b"], byId, "BLUE").map(({track}) => track.id)).toEqual(["a", "b"]);
    expect(filterPlaylistTracks(["a", "b"], byId, "jun").map(({track}) => track.id)).toEqual(["b"]);
  });

  it("sorts without mutating playlist order and keeps ties stable", () => {
    const tracks = [
      makeTrack("b", "Echo", "Mira", "B", 210),
      makeTrack("a", "Afterglow", "Mira", "A", 210),
      makeTrack("c", "Afterglow", "Jun", "C", 180),
    ];
    const rows = filterPlaylistTracks(tracks.map((track) => track.id), new Map(tracks.map((track) => [track.id, track])), "");

    expect(sortPlaylistTracks(rows, "title", "asc").map((track) => track.id)).toEqual(["a", "c", "b"]);
    expect(sortPlaylistTracks(rows, "duration", "desc").map((track) => track.id)).toEqual(["b", "a", "c"]);
    expect(sortPlaylistTracks(rows, "order", "desc").map((track) => track.id)).toEqual(["b", "a", "c"]);
    expect(rows.map(({track}) => track.id)).toEqual(["b", "a", "c"]);
  });
});

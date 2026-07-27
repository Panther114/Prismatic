import {describe, expect, it} from "vitest";
import {toggleTrackMembership} from "./PlaylistView";

describe("playlist membership", () => {
  it("adds a library track to the end of a playlist", () => {
    expect(toggleTrackMembership(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removes an included track without disturbing order", () => {
    expect(toggleTrackMembership(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

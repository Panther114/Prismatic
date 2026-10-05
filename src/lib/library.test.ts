import {describe, expect, it} from "vitest";
import {favoriteIdSet, FAVORITES_NAME, findFavorites, toggleFavoriteIds} from "./favorites";
import {pushRecent} from "./history";
import {accentFromId, rgbToAccent} from "./accent";
import {MAX_RATE, MIN_RATE, normalizeRate} from "./playerPrefs";
import type {Playlist} from "../types";

const playlist = (id: string, name: string, trackIds: string[]): Playlist => ({id, name, trackIds, createdAt: "", updatedAt: ""});

describe("favorites", () => {
  it("finds the reserved playlist by name only", () => {
    const list = [playlist("a", "Mix", ["1"]), playlist("b", FAVORITES_NAME, ["2", "3"])];
    expect(findFavorites(list)?.id).toBe("b");
    expect([...favoriteIdSet(list)]).toEqual(["2", "3"]);
    expect(favoriteIdSet([]).size).toBe(0);
  });
  it("toggles, adding new favorites first", () => {
    expect(toggleFavoriteIds(["a"], "b")).toEqual(["b", "a"]);
    expect(toggleFavoriteIds(["b", "a"], "b")).toEqual(["a"]);
  });
});

describe("recent history", () => {
  it("moves repeats to the front and caps the list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("accent", () => {
  it("is deterministic per id", () => {
    expect(accentFromId("pl-1")).toEqual(accentFromId("pl-1"));
    expect(accentFromId("pl-1")).not.toEqual(accentFromId("pl-2"));
  });
  it("derives hue from the colour", () => {
    expect(rgbToAccent(255, 0, 0).h).toBe(0);
    expect(rgbToAccent(0, 255, 0).h).toBe(120);
    expect(rgbToAccent(0, 0, 255).h).toBe(240);
  });
});

describe("playback rate", () => {
  it("clamps and snaps to 0.05 steps", () => {
    expect(normalizeRate(9)).toBe(MAX_RATE);
    expect(normalizeRate(0.1)).toBe(MIN_RATE);
    expect(normalizeRate(1.23)).toBe(1.25);
    expect(normalizeRate("fast")).toBe(1);
    expect(normalizeRate(NaN)).toBe(1);
  });
});

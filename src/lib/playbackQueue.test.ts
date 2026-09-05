import {describe, expect, it} from "vitest";
import {
  createQueue,
  clearUpcoming,
  currentId,
  enqueueNext,
  getUpcomingIds,
  getUpcomingQueue,
  onTrackEnded,
  pruneQueueToTrackIds,
  removeTrackFromQueue,
  reorderQueue,
  setRepeat,
  skipPrev,
  syncQueueToTrackIds,
} from "./playbackQueue";

describe("playback queue", () => {
  it("shuffle without startId plays the first of the shuffled order (not always base[0])", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // Statistical: across many shuffles, base[0] should not always be current.
    let firstIsA = 0;
    for (let i = 0; i < 40; i += 1) {
      const queue = createQueue(ids, {shuffle: true});
      if (currentId(queue) === "a") firstIsA += 1;
      expect(queue.order).toHaveLength(ids.length);
      expect(new Set(queue.order)).toEqual(new Set(ids));
      expect(queue.index).toBe(0);
    }
    expect(firstIsA).toBeLessThan(40);
  });

  it("shuffle with startId still opens on that track", () => {
    const queue = createQueue(["a", "b", "c", "d"], {shuffle: true, startId: "c"});
    expect(currentId(queue)).toBe("c");
    expect(queue.order[0]).toBe("c");
  });

  it("preserves the current track when items are reordered", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "b"});
    const reordered = reorderQueue(queue, 2, 0);
    expect(reordered.order).toEqual(["c", "a", "b"]);
    expect(currentId(reordered)).toBe("b");
  });

  it("inserts play-next without duplicating a track", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "a"});
    expect(enqueueNext(queue, "c").order).toEqual(["a", "c", "b"]);
  });

  it("preserves the current track when play-next repositions an earlier item", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "b"});
    const next = enqueueNext(queue, "a");
    expect(next.order).toEqual(["b", "a", "c"]);
    expect(next.index).toBe(0);
    expect(currentId(next)).toBe("b");
  });

  it("advances, repeats one, and wraps repeat-all", () => {
    const queue = createQueue(["a", "b"], {startId: "a"});
    expect(onTrackEnded(queue).trackId).toBe("b");
    expect(onTrackEnded(setRepeat(queue, "one")).trackId).toBe("a");
    const last = {...setRepeat(queue, "all"), index: 1};
    expect(onTrackEnded(last).trackId).toBe("a");
  });

  it("removes unavailable items while keeping a valid current selection", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "b"});
    const next = removeTrackFromQueue(queue, "a");
    expect(next.order).toEqual(["b", "c"]);
    expect(currentId(next)).toBe("b");
  });

  it("moves to the immediate successor when the current item is removed", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "b"});
    const next = removeTrackFromQueue(queue, "b");
    expect(next.order).toEqual(["a", "c"]);
    expect(currentId(next)).toBe("c");
  });

  it("wraps to the first item when removing the last item in a looping queue", () => {
    const queue = {...setRepeat(createQueue(["a", "b", "c"], {startId: "c"}), "all")};
    const next = removeTrackFromQueue(queue, "c");
    expect(next.order).toEqual(["a", "b"]);
    expect(currentId(next)).toBe("a");
  });

  it("restarts the current track before navigating backward", () => {
    const queue = createQueue(["a", "b"], {startId: "b"});
    expect(skipPrev(queue, 12)).toMatchObject({trackId: "b", restart: true});
    expect(skipPrev(queue, 0)).toMatchObject({trackId: "a", restart: false});
  });

  it("projects a finite upcoming cycle for repeat-all and repeat-one", () => {
    const middle = createQueue(["a", "b", "c"], {startId: "b"});
    expect(getUpcomingIds(middle)).toEqual(["c"]);
    expect(getUpcomingQueue(setRepeat(middle, "all"))).toEqual([
      {id: "c", index: 2, cycle: 0},
      {id: "a", index: 0, cycle: 1},
      {id: "b", index: 1, cycle: 1},
    ]);
    expect(getUpcomingIds(setRepeat(middle, "one"))).toEqual(["b"]);

    const last = {...setRepeat(middle, "all"), index: 2};
    expect(getUpcomingIds(last)).toEqual(["a", "b", "c"]);
  });

  it("clears successors without resurrecting past items in repeat-all", () => {
    const queue = setRepeat(createQueue(["a", "b", "c"], {startId: "b"}), "all");
    const cleared = clearUpcoming(queue);
    expect(cleared.order).toEqual(["b"]);
    expect(getUpcomingIds(cleared)).toEqual(["b"]);
  });

  it("reconciles a playing playlist after tracks are added or removed", () => {
    const queue = createQueue(["a", "b", "c"], {
      startId: "b",
      sourceLabel: "Mix",
      source: {kind: "playlist", playlistId: "mix", name: "Mix"},
    });
    const added = syncQueueToTrackIds(queue, ["a", "b", "c", "d"], queue.source);
    expect(added.order).toEqual(["a", "b", "c", "d"]);
    expect(currentId(added)).toBe("b");
    expect(getUpcomingIds(added)).toEqual(["c", "d"]);

    const removed = syncQueueToTrackIds(added, ["a", "c", "d"], {kind: "playlist", playlistId: "mix", name: "Renamed"});
    expect(removed.order).toEqual(["a", "c", "d"]);
    expect(currentId(removed)).toBe("c");
    expect(removed.sourceLabel).toBe("Renamed");
    expect(removed.source).toEqual({kind: "playlist", playlistId: "mix", name: "Renamed"});
  });

  it("keeps a manually reordered queue when only the playlist name changes", () => {
    const queue = reorderQueue(
      createQueue(["a", "b", "c"], {
        startId: "a",
        source: {kind: "playlist", playlistId: "mix", name: "Mix"},
      }),
      2,
      1,
    );
    const renamed = syncQueueToTrackIds(queue, ["a", "b", "c"], {
      kind: "playlist",
      playlistId: "mix",
      name: "Renamed",
    });
    expect(renamed.order).toEqual(queue.order);
    expect(renamed.sourceLabel).toBe("Renamed");
  });

  it("preserves a queue removal until the source removes and re-adds that id", () => {
    const queue = createQueue(["a", "b", "c"], {
      startId: "a",
      source: {kind: "playlist", playlistId: "mix", name: "Mix"},
    });
    const removed = removeTrackFromQueue(queue, "b");
    const refreshed = syncQueueToTrackIds(removed, ["a", "b", "c"], queue.source);
    expect(refreshed.order).toEqual(["a", "c"]);

    const sourceRemoved = syncQueueToTrackIds(refreshed, ["a", "c"], queue.source);
    const sourceReadded = syncQueueToTrackIds(sourceRemoved, ["a", "b", "c"], queue.source);
    expect(sourceReadded.order).toEqual(["a", "b", "c"]);
  });

  it("applies an external playlist reorder without changing the current id", () => {
    const queue = createQueue(["a", "b", "c"], {
      startId: "b",
      source: {kind: "playlist", playlistId: "mix", name: "Mix"},
    });
    const reordered = syncQueueToTrackIds(queue, ["c", "b", "a"], queue.source);
    expect(reordered.order).toEqual(["c", "b", "a"]);
    expect(currentId(reordered)).toBe("b");
  });

  it("prunes unavailable library tracks without adding new imports", () => {
    const queue = createQueue(["a", "b", "c"], {startId: "b", source: {kind: "library"}});
    const pruned = pruneQueueToTrackIds(queue, ["b", "c", "new"]);
    expect(pruned.order).toEqual(["b", "c"]);
    expect(pruned.baseOrder).toEqual(["b", "c"]);
    expect(currentId(pruned)).toBe("b");
  });
});

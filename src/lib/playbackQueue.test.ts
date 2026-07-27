import {describe, expect, it} from "vitest";
import {
  createQueue,
  currentId,
  enqueueNext,
  onTrackEnded,
  removeTrackFromQueue,
  reorderQueue,
  setRepeat,
  skipPrev,
} from "./playbackQueue";

describe("playback queue", () => {
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

  it("restarts the current track before navigating backward", () => {
    const queue = createQueue(["a", "b"], {startId: "b"});
    expect(skipPrev(queue, 12)).toMatchObject({trackId: "b", restart: true});
    expect(skipPrev(queue, 0)).toMatchObject({trackId: "a", restart: false});
  });
});

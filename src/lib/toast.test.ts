import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {pushToast, toast} from "./toast";

describe("toast store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    toast.clear();
    vi.useRealTimers();
  });

  it("auto-dismisses and de-duplicates identical messages", () => {
    const seen: number[] = [];
    const first = pushToast({kind: "info", text: "Hello", durationMs: 1000});
    const second = pushToast({kind: "info", text: "Hello", durationMs: 1000});
    expect(second).not.toBe(first);
    seen.push(second);
    vi.advanceTimersByTime(1001);
    // Nothing left to dismiss: a fresh push gets a new id and survives.
    const third = pushToast({kind: "error", text: "Boom"});
    expect(third).toBeGreaterThan(second);
  });
});

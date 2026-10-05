import {beforeEach, describe, expect, it, vi} from "vitest";
import {loadResumePoint, saveResumePoint, shouldResume} from "./resumeStore";

function installStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

describe("shouldResume", () => {
  it("skips positions near the start or end", () => {
    expect(shouldResume(1, 200)).toBe(false);
    expect(shouldResume(3, 200)).toBe(false);
    expect(shouldResume(198, 200)).toBe(false);
  });
  it("resumes mid-track and tolerates unknown duration", () => {
    expect(shouldResume(60, 200)).toBe(true);
    expect(shouldResume(60, NaN)).toBe(true);
    expect(shouldResume(NaN, 200)).toBe(false);
  });
});

describe("resume point storage", () => {
  beforeEach(() => {
    installStorage();
  });
  it("round-trips and rounds to a tenth", () => {
    saveResumePoint({trackId: "abc", position: 12.3456});
    expect(loadResumePoint()).toEqual({trackId: "abc", position: 12.3});
  });
  it("clears on null and rejects corrupt data", () => {
    saveResumePoint({trackId: "abc", position: 10});
    saveResumePoint(null);
    expect(loadResumePoint()).toBeNull();
    localStorage.setItem("prismatic.resume.v1", "{nope");
    expect(loadResumePoint()).toBeNull();
    localStorage.setItem("prismatic.resume.v1", JSON.stringify({trackId: "", position: 5}));
    expect(loadResumePoint()).toBeNull();
  });
  it("survives unavailable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => saveResumePoint({trackId: "a", position: 9})).not.toThrow();
    expect(loadResumePoint()).toBeNull();
  });
});

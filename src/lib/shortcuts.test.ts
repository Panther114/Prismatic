import {describe, expect, it} from "vitest";
import {digitSeekRatio, resolveShortcut, SHORTCUTS} from "./shortcuts";

const key = (init: Partial<KeyboardEvent> & {key: string}) =>
  ({code: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init});

describe("resolveShortcut", () => {
  it("maps plain keys", () => {
    expect(resolveShortcut(key({key: " ", code: "Space"}))).toBe("playPause");
    expect(resolveShortcut(key({key: "n"}))).toBe("next");
    expect(resolveShortcut(key({key: "N"}))).toBe("next");
    expect(resolveShortcut(key({key: "?", shiftKey: true}))).toBe("help");
    expect(resolveShortcut(key({key: "ArrowUp"}))).toBe("volumeUp");
  });

  it("distinguishes short and long seeks", () => {
    expect(resolveShortcut(key({key: "ArrowRight"}))).toBe("seekForward");
    expect(resolveShortcut(key({key: "ArrowRight", shiftKey: true}))).toBe("seekForwardLong");
  });

  it("no longer treats Ctrl+Q (OS quit) as a shortcut", () => {
    expect(resolveShortcut(key({key: "q", ctrlKey: true}))).toBeNull();
    expect(resolveShortcut(key({key: "q"}))).toBe("queue");
  });

  it("keeps modifier shortcuts", () => {
    expect(resolveShortcut(key({key: "o", ctrlKey: true}))).toBe("import");
    expect(resolveShortcut(key({key: "f", metaKey: true}))).toBe("search");
    expect(resolveShortcut(key({key: "4", altKey: true}))).toBe("nowPlaying");
  });

  it("ignores unmapped keys", () => {
    expect(resolveShortcut(key({key: "x"}))).toBeNull();
  });

  it("every listed action is reachable from a key", () => {
    const reachable = new Set<string>();
    const samples = [
      key({key: " ", code: "Space"}), key({key: "n"}), key({key: "p"}), key({key: "ArrowLeft"}), key({key: "ArrowRight"}),
      key({key: "ArrowLeft", shiftKey: true}), key({key: "ArrowRight", shiftKey: true}), key({key: "["}), key({key: "]"}),
      key({key: "ArrowUp"}), key({key: "ArrowDown"}), key({key: "m"}), key({key: "s"}), key({key: "r"}), key({key: "/"}),
      key({key: "q"}), key({key: "1", altKey: true}), key({key: "2", altKey: true}), key({key: "3", altKey: true}),
      key({key: "4", altKey: true}), key({key: "o", ctrlKey: true}), key({key: "?"}),
    ];
    for (const sample of samples) {
      const action = resolveShortcut(sample);
      if (action) reachable.add(action);
    }
    for (const item of SHORTCUTS) expect(reachable.has(item.action), item.action).toBe(true);
  });
});

describe("digitSeekRatio", () => {
  it("maps digits to tenths", () => {
    expect(digitSeekRatio(key({key: "0"}))).toBe(0);
    expect(digitSeekRatio(key({key: "5"}))).toBe(0.5);
  });
  it("ignores modified digits (Alt+1 navigates)", () => {
    expect(digitSeekRatio(key({key: "1", altKey: true}))).toBeNull();
  });
});

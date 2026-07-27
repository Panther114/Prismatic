import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {MusicLibrary} from "./library";

const roots: string[] = [];

function silentWav() {
  const buffer = Buffer.alloc(46);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(38, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(2, 40);
  return buffer;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prismatic-library-"));
  roots.push(root);
  const managed = path.join(root, "managed");
  const state = path.join(root, "state");
  const external = path.join(root, "external");
  await Promise.all([mkdir(managed), mkdir(state), mkdir(external)]);
  await writeFile(path.join(managed, "managed.wav"), silentWav());
  await writeFile(path.join(external, "external.wav"), silentWav());
  const library = new MusicLibrary(root, managed, state);
  await library.addWatchFolder(external);
  return {library, managed, external};
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe("library deletion safety", () => {
  it("never deletes a watched-folder source during individual removal", async () => {
    const {library, external} = await fixture();
    try {
      const track = (await library.list()).find((item) => item.sourceId !== "music");
      expect(track).toBeTruthy();
      await library.remove(track!.id, {deleteFile: true});
      expect(await readFile(path.join(external, "external.wav"))).toHaveLength(46);
      expect((await library.list()).some((item) => item.id === track!.id)).toBe(false);
    } finally {
      library.dispose();
    }
  });

  it("clears managed files and watch settings while preserving external files", async () => {
    const {library, managed, external} = await fixture();
    try {
      const result = await library.clear();
      expect(result.deletedManagedFiles).toBe(1);
      expect(result.preservedExternalFiles).toBe(1);
      expect(result.failedManagedFiles).toEqual([]);
      await expect(readFile(path.join(managed, "managed.wav"))).rejects.toThrow();
      expect(await readFile(path.join(external, "external.wav"))).toHaveLength(46);
      expect(await library.getWatchFolders()).toEqual([]);
      expect(await library.list()).toEqual([]);
    } finally {
      library.dispose();
    }
  });
});

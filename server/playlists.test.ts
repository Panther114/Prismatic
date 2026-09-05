import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {PlaylistRepository} from "./playlists";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe("playlist repository", () => {
  it("refreshes cached playlists when another client writes the state file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prismatic-playlists-"));
    roots.push(root);
    const repository = new PlaylistRepository(root);
    const created = await repository.create({name: "Original"});
    expect((await repository.list()).map((playlist) => playlist.name)).toEqual(["Original"]);

    const replacement = [{
      ...created,
      name: "External edit",
      updatedAt: new Date().toISOString(),
    }];
    await writeFile(path.join(root, "playlists.json"), `${JSON.stringify(replacement)}\n`, "utf8");
    expect((await repository.list()).map((playlist) => playlist.name)).toEqual(["External edit"]);
  });

  it("does not throw or corrupt a playlist for a malformed trackIds patch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prismatic-playlists-"));
    roots.push(root);
    const repository = new PlaylistRepository(root);
    const created = await repository.create({name: "Stable", trackIds: ["a"]});
    const updated = await repository.update(created.id, {trackIds: "not-an-array" as unknown as string[]});
    expect(updated?.trackIds).toEqual(["a"]);
    expect(await readFile(path.join(root, "playlists.json"), "utf8")).toContain('"Stable"');
  });
});

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

describe("ArtifactStore", () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await createTempDir();
    store = new ArtifactStore(root);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("stores immutable content by SHA-256 with private permissions and exact length", async () => {
    const content = Buffer.from("content_id,clicks\ncontent-1,3\n");
    const expectedHash = createHash("sha256").update(content).digest("hex");

    const stored = await store.put(content);
    expect(stored).toEqual({ contentHash: expectedHash, byteLength: content.length });
    expect(await readFile(join(root, expectedHash))).toEqual(content);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, expectedHash))).mode & 0o777).toBe(0o600);
    expect(await store.read(expectedHash)).toEqual(content);

    await store.put(content);
    expect((await readdir(root)).sort()).toEqual([expectedHash]);
  });

  it("rejects path-like identifiers and detects content that no longer matches its hash", async () => {
    const stored = await store.put(Buffer.from("evidence"));

    await expect(store.read("../outside")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await writeFile(join(root, stored.contentHash), "tampered");
    await expect(store.read(stored.contentHash)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

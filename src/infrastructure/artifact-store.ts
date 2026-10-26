import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DomainError } from "../domain/errors.js";

export interface StoredArtifact {
  contentHash: string;
  byteLength: number;
}

export class ArtifactStore {
  constructor(private readonly configuredRoot?: string) {}

  async put(content: Uint8Array): Promise<StoredArtifact> {
    const root = await this.root();
    const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const target = join(root, contentHash);
    const temporary = join(root, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      await chmod(target, 0o600);
      return { contentHash, byteLength: bytes.length };
    } finally {
      await unlink(temporary);
    }
  }

  async read(contentHash: string): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new DomainError("NOT_FOUND", "Evidence asset not found");
    }
    const root = await this.root();
    const target = join(root, contentHash);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new DomainError("NOT_FOUND", "Evidence asset not found");
      }
      const content = await handle.readFile();
      if (createHash("sha256").update(content).digest("hex") !== contentHash) {
        throw new DomainError("CONFLICT", "Evidence artifact content hash does not match");
      }
      return content;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError("NOT_FOUND", "Evidence asset not found");
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async root(): Promise<string> {
    const configured = this.configuredRoot ?? process.env.MARKETING_ARTIFACT_DIR;
    if (!configured) {
      throw new Error("MARKETING_ARTIFACT_DIR is required for evidence artifacts");
    }
    const root = resolve(configured);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("MARKETING_ARTIFACT_DIR must be a directory");
    }
    return root;
  }
}

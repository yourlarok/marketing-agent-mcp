import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it("loads a valid temporary data directory", () => {
    expect(loadConfig({ MARKETING_DATA_DIR: tempDir })).toEqual({
      dataDir: tempDir,
      logLevel: "info",
    });
  });

  it("rejects a missing MARKETING_DATA_DIR", () => {
    expect(() => loadConfig({})).toThrow("MARKETING_DATA_DIR");
  });

  it("rejects a data directory path that is an existing file", async () => {
    const filePath = join(tempDir, "data.txt");
    await writeFile(filePath, "not a directory");

    expect(() => loadConfig({ MARKETING_DATA_DIR: filePath })).toThrow(
      "MARKETING_DATA_DIR",
    );
  });
});

describe("MCP server", () => {
  it("initializes over linked memory transports with an empty tool list", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      expect(await client.listTools()).toEqual({ tools: [] });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

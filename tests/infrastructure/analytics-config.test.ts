import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createTempDir } from "../helpers.js";

describe("professional analytics MCP deployment configuration", () => {
  it("loads command and JSON string-array args only from trusted environment configuration", async () => {
    const dataDir = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_ANALYTICS_MCP_COMMAND: "/trusted/analytics",
        MARKETING_ANALYTICS_MCP_ARGS: JSON.stringify(["--mode", "readonly"]),
      })).toEqual({
        dataDir,
        analyticsMcp: { command: "/trusted/analytics", args: ["--mode", "readonly"] },
        logLevel: "info",
      });
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });

  it("rejects analytics args without a command and malformed args", async () => {
    const dataDir = await createTempDir();
    try {
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_ANALYTICS_MCP_ARGS: "[]",
      })).toThrow("MARKETING_ANALYTICS_MCP_COMMAND");
      for (const args of ["not-json", "{}", "[1]"]) {
        expect(() => loadConfig({
          MARKETING_DATA_DIR: dataDir,
          MARKETING_ANALYTICS_MCP_COMMAND: "/trusted/analytics",
          MARKETING_ANALYTICS_MCP_ARGS: args,
        })).toThrow("MARKETING_ANALYTICS_MCP_ARGS must be a JSON string array");
      }
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createTempDir } from "../helpers.js";

describe("benchmark reverse MCP deployment configuration", () => {
  it("loads only trusted benchmark command and JSON string-array args", async () => {
    const dataDir = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_BENCHMARK_MCP_COMMAND: "/trusted/benchmark",
        MARKETING_BENCHMARK_MCP_ARGS: JSON.stringify(["--mode", "readonly"]),
      })).toEqual({
        dataDir,
        benchmarkMcp: { command: "/trusted/benchmark", args: ["--mode", "readonly"] },
        logLevel: "info",
      });
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });

  it("rejects benchmark args without a command, malformed args, non-string args, and empty commands", async () => {
    const dataDir = await createTempDir();
    try {
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_BENCHMARK_MCP_ARGS: "[]",
      })).toThrow("MARKETING_BENCHMARK_MCP_COMMAND");
      for (const args of ["not-json", "{}", "[1]"]) {
        expect(() => loadConfig({
          MARKETING_DATA_DIR: dataDir,
          MARKETING_BENCHMARK_MCP_COMMAND: "/trusted/benchmark",
          MARKETING_BENCHMARK_MCP_ARGS: args,
        })).toThrow("MARKETING_BENCHMARK_MCP_ARGS must be a JSON string array");
      }
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_BENCHMARK_MCP_COMMAND: "   ",
      })).toThrow("MARKETING_BENCHMARK_MCP_COMMAND must not be empty");
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });
});

describe("professional media and video probe deployment configuration", () => {
  it("loads trusted media command, args, environment names, and absolute ffprobe path", async () => {
    const dataDir = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_MEDIA_MCP_COMMAND: "/trusted/media",
        MARKETING_MEDIA_MCP_ARGS: JSON.stringify(["--mode", "render"]),
        MARKETING_MEDIA_MCP_ENV_ALLOWLIST: " MEDIA_FIXTURE_MODE, MARKETING_TEST_FFMPEG ",
        MARKETING_FFPROBE_COMMAND: "/usr/local/bin/ffprobe",
      })).toEqual({
        dataDir,
        mediaMcp: {
          command: "/trusted/media",
          args: ["--mode", "render"],
          envAllowlist: ["MEDIA_FIXTURE_MODE", "MARKETING_TEST_FFMPEG"],
        },
        ffprobeCommand: "/usr/local/bin/ffprobe",
        logLevel: "info",
      });
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });

  it("rejects orphaned media settings, malformed args, empty commands, and relative ffprobe paths", async () => {
    const dataDir = await createTempDir();
    try {
      for (const env of [
        { MARKETING_MEDIA_MCP_ARGS: "[]" },
        { MARKETING_MEDIA_MCP_ENV_ALLOWLIST: "MEDIA_FIXTURE_MODE" },
      ]) {
        expect(() => loadConfig({ MARKETING_DATA_DIR: dataDir, ...env }))
          .toThrow("MARKETING_MEDIA_MCP_COMMAND");
      }
      for (const args of ["not-json", "{}", "[1]"]) {
        expect(() => loadConfig({
          MARKETING_DATA_DIR: dataDir,
          MARKETING_MEDIA_MCP_COMMAND: "/trusted/media",
          MARKETING_MEDIA_MCP_ARGS: args,
        })).toThrow("MARKETING_MEDIA_MCP_ARGS must be a JSON string array");
      }
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_MEDIA_MCP_COMMAND: "  ",
      })).toThrow("MARKETING_MEDIA_MCP_COMMAND must not be empty");
      for (const command of ["ffprobe", "relative/ffprobe", "  "]) {
        expect(() => loadConfig({
          MARKETING_DATA_DIR: dataDir,
          MARKETING_FFPROBE_COMMAND: command,
        })).toThrow("MARKETING_FFPROBE_COMMAND must be an absolute executable path");
      }
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });
});

describe("trusted publishing MCP deployment configuration", () => {
  it("loads only trusted command, JSON string-array args, and environment allowlist", async () => {
    const dataDir = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_PUBLISHING_MCP_COMMAND: "/trusted/publishing",
        MARKETING_PUBLISHING_MCP_ARGS: JSON.stringify(["--mode", "fixture"]),
        MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST: " PUBLISHING_FIXTURE_STATE, PUBLISHING_FIXTURE_MODE ",
      })).toEqual({
        dataDir,
        publishingMcp: {
          command: "/trusted/publishing",
          args: ["--mode", "fixture"],
          envAllowlist: ["PUBLISHING_FIXTURE_STATE", "PUBLISHING_FIXTURE_MODE"],
        },
        logLevel: "info",
      });
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });

  it("rejects orphaned settings, malformed args, empty commands, and invalid environment names", async () => {
    const dataDir = await createTempDir();
    try {
      for (const env of [
        { MARKETING_PUBLISHING_MCP_ARGS: "[]" },
        { MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST: "PUBLISHING_FIXTURE_STATE" },
      ]) {
        expect(() => loadConfig({ MARKETING_DATA_DIR: dataDir, ...env }))
          .toThrow("MARKETING_PUBLISHING_MCP_COMMAND");
      }
      for (const args of ["not-json", "{}", "[1]"]) {
        expect(() => loadConfig({
          MARKETING_DATA_DIR: dataDir,
          MARKETING_PUBLISHING_MCP_COMMAND: "/trusted/publishing",
          MARKETING_PUBLISHING_MCP_ARGS: args,
        })).toThrow("MARKETING_PUBLISHING_MCP_ARGS must be a JSON string array");
      }
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_PUBLISHING_MCP_COMMAND: "  ",
      })).toThrow("MARKETING_PUBLISHING_MCP_COMMAND must not be empty");
      expect(() => loadConfig({
        MARKETING_DATA_DIR: dataDir,
        MARKETING_PUBLISHING_MCP_COMMAND: "/trusted/publishing",
        MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST: "VALID_NAME,not-a-name",
      })).toThrow("MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST");
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dataDir, { recursive: true, force: true }));
    }
  });
});

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

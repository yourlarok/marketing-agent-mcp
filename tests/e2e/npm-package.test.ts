import { type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

interface NpmPackResult {
  filename: string;
  files: Array<{ path: string }>;
}

function packagedProcess(transport: StdioClientTransport): ChildProcess {
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  expect(child).toBeDefined();
  return child as ChildProcess;
}

async function runtimeProcessPids(runtimeRoot: string): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const pid = Number(match?.[1]);
    return pid !== process.pid && match?.[2]?.includes(`${runtimeRoot}/`) ? [pid] : [];
  });
}

describe("npm package and npx acceptance", () => {
  let tempDir: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("packs only deployment files and runs all migrations through npx outside the repository", async () => {
    tempDir = await createTempDir();
    const packDir = join(tempDir, "pack");
    const unpackedDir = join(tempDir, "unpacked");
    const emptyCwd = join(tempDir, "empty-cwd");
    const dataDir = join(tempDir, "data");
    const importDir = join(tempDir, "imports");
    const artifactDir = join(tempDir, "artifacts");
    await Promise.all([
      mkdir(packDir),
      mkdir(unpackedDir),
      mkdir(emptyCwd),
      mkdir(dataDir),
      mkdir(importDir),
      mkdir(artifactDir),
    ]);

    const { stdout: packOutput } = await execFileAsync("npm", [
      "pack",
      "--json",
      "--pack-destination",
      packDir,
    ], {
      cwd: projectRoot,
      env: { ...process.env, npm_config_update_notifier: "false" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const [packResult] = JSON.parse(packOutput) as NpmPackResult[];
    const tarball = join(packDir, packResult.filename);
    await execFileAsync("tar", ["-xzf", tarball, "-C", unpackedDir]);
    const packageDir = join(unpackedDir, "package");
    const manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      files: string[];
      engines: { node: string };
      scripts: { prepack: string };
    };

    expect(manifest).toMatchObject({
      name: "@yourlarok/marketing-agent-mcp",
      version: "1.0.0",
      bin: { "marketing-agent-mcp": "dist/index.js" },
      engines: { node: ">=22.23.1" },
      scripts: { prepack: "npm run build" },
    });
    expect(manifest.files).toEqual(["dist", "migrations", "README.md", "LICENSE"]);

    const packagedPaths = packResult.files.map((file) => file.path).sort();
    expect(packagedPaths).toEqual(expect.arrayContaining([
      "dist/index.js",
      "migrations/001_initial.sql",
      "migrations/007_immutable_effect_references.sql",
      "README.md",
      "LICENSE",
      "package.json",
    ]));
    for (const path of packagedPaths) {
      expect(
        path === "package.json" ||
          path === "README.md" ||
          path === "LICENSE" ||
          path.startsWith("dist/") ||
          path.startsWith("migrations/"),
        `unexpected packaged path: ${path}`,
      ).toBe(true);
      expect(path).not.toMatch(/^(?:src|tests|plans|data|node_modules|coverage)(?:\/|$)/);
      expect(path).not.toMatch(/(?:^|\/)(?:\.env|marketing\.db|npm-debug\.log)/);
    }
    const sourceMigrations = (await readdir(join(projectRoot, "migrations"))).sort();
    const packagedMigrations = (await readdir(join(packageDir, "migrations"))).sort();
    expect(packagedMigrations).toEqual(sourceMigrations);

    const executable = join(packageDir, "dist", "index.js");
    expect((await readFile(executable, "utf8")).split("\n", 1)[0]).toBe("#!/usr/bin/env node");
    expect((await stat(executable)).mode & 0o111).not.toBe(0);

    client = new Client({ name: "npm-package-acceptance", version: "1.0.0" });
    const pathWithoutRepository = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((entry) => !resolve(entry).startsWith(`${resolve(projectRoot)}/`))
      .join(delimiter);
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", "--package", tarball, "marketing-agent-mcp"],
      cwd: emptyCwd,
      env: {
        PATH: pathWithoutRepository,
        MARKETING_DATA_DIR: dataDir,
        MARKETING_IMPORT_ROOT: importDir,
        MARKETING_ARTIFACT_DIR: artifactDir,
        npm_config_cache: join(tempDir, "npm-cache"),
        npm_config_update_notifier: "false",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`npx MCP startup failed; stderr:\n${stderr}`, { cause: error });
    }
    const child = packagedProcess(transport);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    const childPid = transport.pid;
    expect(childPid).not.toBeNull();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(71);
    expect(await runtimeProcessPids(tempDir)).not.toEqual([]);
    await client.close();
    client = undefined;
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(stderr).not.toContain("MCP shutdown failed");
    const protocolMessages = stdout.split("\n").filter(Boolean).map(
      (line) => JSON.parse(line) as { jsonrpc: string },
    );
    expect(protocolMessages.length).toBeGreaterThan(0);
    expect(protocolMessages.every((message) => message.jsonrpc === "2.0")).toBe(true);
    expect(() => process.kill(childPid as number, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
    await expect.poll(() => runtimeProcessPids(tempDir), {
      timeout: 5_000,
      interval: 100,
    }).toEqual([]);

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "marketing.db"), { readOnly: true });
    try {
      const versions = database.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all() as Array<{ version: number }>;
      expect(versions.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      database.close();
    }
  }, 120_000);
});

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/application/commands.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import type { Store } from "../../src/application/ports.js";
import { loadConfig } from "../../src/config.js";
import type { Evidence } from "../../src/domain/model.js";
import { DomainError } from "../../src/domain/errors.js";
import { AcquisitionRouter } from "../../src/infrastructure/acquisition-router.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { McpAcquisitionProvider } from "../../src/infrastructure/mcp-acquisition.js";
import { PlaywrightAcquisitionProvider } from "../../src/infrastructure/playwright-acquisition.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const fixtureRoot = resolve("tests/fixtures/http-site");
const fixtureCommand = resolve("tests/fixtures/http-site/mcp-fixture.mjs");
const now = "2026-10-26T12:30:00.000Z";

async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("content acquisition", () => {
  let server: Server;
  let baseUrl: string;
  let documentHits: number;
  let privateHits: number;
  let redirectHits: number;
  let serviceWorkerHits: number;
  let webSocketHits: number;
  let cookies: (string | undefined)[];

  beforeEach(async () => {
    documentHits = 0;
    privateHits = 0;
    redirectHits = 0;
    serviceWorkerHits = 0;
    webSocketHits = 0;
    cookies = [];
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      if (path === "/private.js") {
        privateHits += 1;
      }
      if (["/dynamic", "/subrequest", "/download"].includes(path)) {
        documentHits += 1;
        cookies.push(request.headers.cookie);
        response.setHeader("set-cookie", "fixture_session=persisted; Path=/; HttpOnly");
      }
      if (["/401", "/403", "/429"].includes(path)) {
        response.writeHead(Number(path.slice(1)), { "content-type": "text/html" });
        response.end("<html><body>Access denied</body></html>");
        return;
      }
      if (path === "/login") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body><h1>Please log in to continue</h1></body></html>");
        return;
      }
      if (path === "/captcha") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body><h1>CAPTCHA verification required</h1></body></html>");
        return;
      }
      if (path === "/redirect") {
        response.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/redirect-target` });
        response.end();
        return;
      }
      if (path === "/redirect-target") {
        redirectHits += 1;
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body>Redirect target reached</body></html>");
        return;
      }
      if (path === "/channels") {
        const port = (server.address() as AddressInfo).port;
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<html><body>Channel fixture<script>navigator.serviceWorker.register("http://127.0.0.1:${port}/sw.js").catch(() => {}); new WebSocket("ws://127.0.0.1:${port}/socket");</script></body></html>`);
        return;
      }
      if (path === "/sw.js") {
        serviceWorkerHits += 1;
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("self.addEventListener('fetch', () => {});");
        return;
      }
      if (path === "/dynamic") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html><head><title>Initial title</title></head><body><h1 id=\"headline\">Loading</h1><p class=\"price\"></p><div id=\"client-content\"></div><script src=\"/app.js\"></script></body></html>");
        return;
      }
      if (path === "/subrequest" || path === "/download") {
        const file = path === "/subrequest" ? "subrequest.html" : "download.html";
        void readFile(join(fixtureRoot, file), "utf8").then((html) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(html.replace("PORT", String((server.address() as AddressInfo).port)));
        });
        return;
      }
      const file = path === "/app.js" ? "app.js" : path === "/private.js" ? "private.js" : "download.txt";
      void readFile(join(fixtureRoot, file)).then((content) => {
        response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/plain" });
        response.end(content);
      });
    });
    server.on("upgrade", (_request, socket) => {
      webSocketHits += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    baseUrl = await serve(server);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  function playwright(extra: { allowlist?: string[] } = {}): PlaywrightAcquisitionProvider {
    return new PlaywrightAcquisitionProvider({
      allowlist: extra.allowlist ?? ["127.0.0.1"],
    });
  }

  it("renders a dynamic page in real Chromium and returns CSS fields and PNG bytes", async () => {
    const page = await playwright().acquire({
      url: `${baseUrl}/dynamic`,
      fields: { headline: "#headline", price: ".price" },
    });

    expect(page).toMatchObject({
      provider: "playwright",
      finalUrl: `${baseUrl}/dynamic`,
      title: "Rendered campaign",
      fields: { headline: "Rendered by Chromium", price: "USD 42" },
    });
    expect(page.text).toContain("Client-only campaign detail");
    expect(page.text).not.toContain("Loading");
    expect(page.screenshot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(page.screenshot.length).toBeGreaterThan(1_000);
    expect(page.toolVersion).not.toBe("");
  }, 20_000);

  it("uses a fresh context with no persisted cookies between acquisitions", async () => {
    const provider = playwright();
    await provider.acquire({ url: `${baseUrl}/dynamic` });
    await provider.acquire({ url: `${baseUrl}/dynamic` });

    expect(cookies).toEqual([undefined, undefined]);
  }, 20_000);

  it("marks startup MCP configuration verified only after a real fixture acquisition and prefers it", async () => {
    const markerRoot = await createTempDir();
    const marker = join(markerRoot, "acquisitions.log");
    const closedBrowser = await chromium.launch({ headless: true });
    await closedBrowser.close();
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MARKER: marker },
      envAllowlist: ["MCP_FIXTURE_MARKER"],
    });
    const router = new AcquisitionRouter({
      mcp,
      playwright: new PlaywrightAcquisitionProvider({ launchBrowser: async () => closedBrowser }),
    });
    try {
      expect(mcp.state).toBe("configured");
      const page = await router.acquire({
        url: `${baseUrl}/dynamic`,
        fields: { headline: "#headline" },
      });
      expect(mcp.state).toBe("verified");
      expect(page).toMatchObject({
        provider: "mcp",
        text: "Acquired through the real MCP fixture",
        fields: { headline: "fixture:headline" },
        toolVersion: "1.0.0",
      });
      expect(page.screenshot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(await readFile(marker, "utf8")).toBe(`${baseUrl}/dynamic\n`);
    } finally {
      await removeTempDir(markerRoot);
    }
  }, 20_000);

  it("proves provider pre-request scope enforcement with a real canary before verification", async () => {
    const markerRoot = await createTempDir();
    const marker = join(markerRoot, "scope-canary.log");
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MARKER: marker },
      envAllowlist: ["MCP_FIXTURE_MARKER"],
    });
    try {
      const page = await mcp.acquire({
        url: `${baseUrl}/dynamic`,
        fields: { headline: "#headline" },
        scope: { hosts: ["127.0.0.1"], pathPrefixes: ["/dynamic"] },
      });
      expect(page.provider).toBe("mcp");
      expect(mcp.state).toBe("verified");
      expect((mcp as unknown as { scopeCanaryHits: number }).scopeCanaryHits).toBe(0);
      const invocations = (await readFile(marker, "utf8")).trim().split("\n");
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toContain("/__marketing_mcp_scope_canary__");
      expect(invocations[1]).toBe(`${baseUrl}/dynamic`);
    } finally {
      await removeTempDir(markerRoot);
    }
  }, 20_000);

  it("rejects a defective provider that hits the out-of-scope canary before denying it", async () => {
    const markerRoot = await createTempDir();
    const marker = join(markerRoot, "defective-scope.log");
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MARKER: marker, MCP_FIXTURE_MODE: "defective-canary" },
      envAllowlist: ["MCP_FIXTURE_MARKER", "MCP_FIXTURE_MODE"],
    });
    try {
      await expect(mcp.acquire({
        url: `${baseUrl}/dynamic`,
        scope: { hosts: ["127.0.0.1"], pathPrefixes: ["/dynamic"] },
      })).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        details: { reason: "mcp_scope_enforcement" },
      });
      expect(mcp.state).toBe("unavailable");
      expect((mcp as unknown as { scopeCanaryHits: number }).scopeCanaryHits).toBe(1);
      const invocations = (await readFile(marker, "utf8")).trim().split("\n");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("/__marketing_mcp_scope_canary__");
    } finally {
      await removeTempDir(markerRoot);
    }
  }, 20_000);

  it("does not verify a provider that ignores scope and forges a legal-looking finalUrl", async () => {
    const markerRoot = await createTempDir();
    const marker = join(markerRoot, "forged-scope.log");
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MARKER: marker, MCP_FIXTURE_MODE: "ignore-scope" },
      envAllowlist: ["MCP_FIXTURE_MARKER", "MCP_FIXTURE_MODE"],
    });
    try {
      await expect(mcp.acquire({
        url: `${baseUrl}/dynamic`,
        scope: { hosts: ["127.0.0.1"], pathPrefixes: ["/dynamic"] },
      })).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        details: { reason: "mcp_scope_enforcement" },
      });
      expect(mcp.state).toBe("unavailable");
      expect((mcp as unknown as { scopeCanaryHits: number }).scopeCanaryHits).toBe(0);
      const invocations = (await readFile(marker, "utf8")).trim().split("\n");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("/__marketing_mcp_scope_canary__");
    } finally {
      await removeTempDir(markerRoot);
    }
  }, 20_000);

  it("falls back from an unhealthy configured MCP provider to Playwright", async () => {
    const mcp = new McpAcquisitionProvider({ command: join(fixtureRoot, "missing-provider"), args: [] });
    const router = new AcquisitionRouter({ mcp, playwright: playwright() });

    const page = await router.acquire({ url: `${baseUrl}/dynamic` });
    expect(page.provider).toBe("playwright");
    expect(page.text).toContain("Rendered by Chromium");
    expect(mcp.state).toBe("unavailable");
  }, 20_000);

  it.each(["401", "403", "429", "login", "captcha"])("does not fall back after MCP %s access gaps", async (gap) => {
    const markerRoot = await createTempDir();
    const marker = join(markerRoot, "gap.log");
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MARKER: marker },
      envAllowlist: ["MCP_FIXTURE_MARKER"],
    });
    const router = new AcquisitionRouter({ mcp, playwright: playwright() });
    try {
      await expect(router.acquire({ url: `${baseUrl}/mcp-${gap}` })).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        details: { reason: ["401", "403", "429"].includes(gap) ? `http_${gap}` : "access_gate" },
      });
      expect(await readFile(marker, "utf8")).toBe(`${baseUrl}/mcp-${gap}\n`);
    } finally {
      await removeTempDir(markerRoot);
    }
  }, 20_000);

  it.each(["fake-png", "wrong-url", "wrong-fields"])("rejects invalid MCP success payload: %s", async (mode) => {
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: { ...process.env, MCP_FIXTURE_MODE: mode },
      envAllowlist: ["MCP_FIXTURE_MODE"],
    });

    await expect(mcp.acquire({ url: `${baseUrl}/dynamic`, fields: { headline: "#headline" } }))
      .rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        details: { reason: "mcp_invalid_response" },
      });
  }, 20_000);

  it("does not inherit unrelated secrets into the MCP child process", async () => {
    const mcp = new McpAcquisitionProvider({
      command: process.execPath,
      args: [fixtureCommand],
      env: {
        ...process.env,
        MCP_FIXTURE_MODE: "environment",
        UNRELATED_SECRET: "must-not-enter-child",
      },
      envAllowlist: ["MCP_FIXTURE_MODE"],
    });

    const page = await mcp.acquire({ url: `${baseUrl}/dynamic` });
    expect(page.text).toBe("secret-absent");
  }, 20_000);

  it("fails explicitly when neither professional MCP nor Chromium can acquire", async () => {
    const closedBrowser = await chromium.launch({ headless: true });
    await closedBrowser.close();
    const router = new AcquisitionRouter({
      mcp: new McpAcquisitionProvider({ command: join(fixtureRoot, "missing-provider"), args: [] }),
      playwright: new PlaywrightAcquisitionProvider({ launchBrowser: async () => closedBrowser }),
    });

    await expect(router.acquire({ url: `${baseUrl}/dynamic` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  }, 20_000);

  it.each([401, 403, 429])("reports HTTP %i as an acquisition gap", async (status) => {
    await expect(playwright().acquire({ url: `${baseUrl}/${status}` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: `http_${status}` },
    });
  }, 20_000);

  it.each(["login", "captcha"])("reports %s gates without bypassing them", async (gate) => {
    await expect(playwright().acquire({ url: `${baseUrl}/${gate}` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "access_gate" },
    });
  }, 20_000);

  it("reports candidate payload bytes when a page fails after reading text", async () => {
    await expect(playwright().acquire({ url: `${baseUrl}/login`, maxBytes: 100_000 })).rejects.toMatchObject({
      details: { reason: "access_gate", payloadBytes: expect.any(Number) },
    });
  }, 20_000);

  it("reports a real Chromium crash as unavailable", async () => {
    const crashedBrowser = await chromium.launch({ headless: true });
    const session = await crashedBrowser.newBrowserCDPSession();
    const disconnected = new Promise<void>((resolveDisconnected) => crashedBrowser.once("disconnected", resolveDisconnected));
    void session.send("Browser.crash").catch(() => undefined);
    await disconnected;
    const provider = new PlaywrightAcquisitionProvider({ launchBrowser: async () => crashedBrowser, allowlist: ["127.0.0.1"] });

    await expect(provider.acquire({ url: `${baseUrl}/dynamic` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "browser_unavailable" },
    });
  }, 20_000);

  it("reports screenshot failure without returning partial page evidence", async () => {
    const provider = new PlaywrightAcquisitionProvider({
      allowlist: ["127.0.0.1"],
      captureScreenshot: async () => { throw new Error("injected screenshot failure"); },
    });

    await expect(provider.acquire({ url: `${baseUrl}/dynamic` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "screenshot_failed" },
    });
  }, 20_000);

  it("denies page-triggered downloads", async () => {
    await expect(playwright().acquire({ url: `${baseUrl}/download` })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "download_denied" },
    });
  }, 20_000);

  it("validates subrequest destinations and blocks a private target omitted from the allowlist", async () => {
    const url = baseUrl.replace("127.0.0.1", "localhost");
    const page = await playwright({ allowlist: ["localhost"] }).acquire({ url: `${url}/subrequest` });

    expect(page.fields).toEqual({});
    expect(page.text).toContain("Allowed main page");
    expect(page.text).not.toContain("Private subrequest executed");
    expect(privateHits).toBe(0);
  }, 20_000);

  it("fails closed when browser DNS differs from the validated address", async () => {
    const provider = new PlaywrightAcquisitionProvider({
      lookup: async () => ["192.0.2.1"],
      timeoutMs: 1_000,
    });

    await expect(provider.acquire({ url: `${baseUrl.replace("127.0.0.1", "localhost")}/dynamic` }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(documentHits).toBe(0);
  }, 20_000);

  it("pins and validates every redirect hop instead of trusting Chromium DNS", async () => {
    const provider = new PlaywrightAcquisitionProvider({
      allowlist: ["127.0.0.1"],
      lookup: async () => ["192.0.2.1"],
      timeoutMs: 1_000,
    });

    await expect(provider.acquire({ url: `${baseUrl}/redirect` }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(redirectHits).toBe(0);
  }, 20_000);

  it("blocks service workers and WebSocket upgrades before private endpoints are hit", async () => {
    const page = await playwright({ allowlist: ["localhost"] }).acquire({
      url: `${baseUrl.replace("127.0.0.1", "localhost")}/channels`,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    expect(page.text).toContain("Channel fixture");
    expect(serviceWorkerHits).toBe(0);
    expect(webSocketHits).toBe(0);
  }, 20_000);

  it("acquires local HTTPS through a destination-validating CONNECT tunnel", async () => {
    const httpsServer: HttpsServer = createHttpsServer({
      key: await readFile(join(fixtureRoot, "localhost-key.pem")),
      cert: await readFile(join(fixtureRoot, "localhost-cert.pem")),
    }, (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body><h1>Secure pinned content</h1></body></html>");
    });
    await new Promise<void>((resolveListen) => httpsServer.listen(0, resolveListen));
    const { port } = httpsServer.address() as AddressInfo;
    try {
      const provider = new PlaywrightAcquisitionProvider({
          allowlist: ["localhost"],
        ignoreHTTPSErrors: true,
      });
      const page = await provider.acquire({ url: `https://localhost:${port}/secure` });
      expect(page.text).toContain("Secure pinned content");
    } finally {
      httpsServer.closeAllConnections();
      await new Promise<void>((resolveClose) => httpsServer.close(() => resolveClose()));
    }
  }, 20_000);

  it("declares Playwright as a runtime dependency", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies.playwright).toBe("^1.64.1");
    expect(manifest.devDependencies.playwright).toBeUndefined();
  });

  it("rejects caller scripts and non-CSS selector input before navigation", async () => {
    const before = documentHits;
    await expect(playwright().acquire({
      url: `${baseUrl}/dynamic`,
      fields: { bad: "body >> text=Rendered" },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(playwright().acquire({
      url: `${baseUrl}/dynamic`,
      script: "process.exit(1)",
    } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(documentHits).toBe(before);
  }, 20_000);

  it("loads professional MCP startup configuration as command arguments, not caller input", async () => {
    const root = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: root,
        MARKETING_CONTENT_MCP_COMMAND: process.execPath,
        MARKETING_CONTENT_MCP_ARGS: JSON.stringify([fixtureCommand]),
      })).toMatchObject({
        contentMcp: { command: process.execPath, args: [fixtureCommand] },
      });
      expect(() => loadConfig({
        MARKETING_DATA_DIR: root,
        MARKETING_CONTENT_MCP_COMMAND: process.execPath,
        MARKETING_CONTENT_MCP_ARGS: "not-json",
      })).toThrow(/MARKETING_CONTENT_MCP_ARGS/);
    } finally {
      await removeTempDir(root);
    }
  });

  it("persists successful link evidence and screenshot bytes in a partial atomic batch", async () => {
    const store: Store = openStore(":memory:");
    const artifactRoot = await createTempDir();
    let sequence = 0;
    const service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `generated-${++sequence}` },
      new ArtifactStore(artifactRoot),
      undefined,
      new AcquisitionRouter({ playwright: playwright() }),
    );
    const context: CommandContext = {
      actor: "agent-1",
      requestId: "request-links",
      idempotencyKey: "command-links",
    };
    try {
      await store.transaction((repos) => repos.workspaces.insert({
        id: "workspace-1",
        workspaceId: "workspace-1",
        version: 1,
        createdAt: now,
        updatedAt: now,
        name: "Workspace",
      }));
      const command = {
        input: {
          id: "batch-links",
          workspaceId: "workspace-1",
          links: [
            { url: `${baseUrl}/dynamic`, fields: { headline: "#headline" } },
            { url: `${baseUrl}/403` },
          ],
        },
        context,
      };
      const batch = await service.ingestContentLinks(command);
      expect(batch).toMatchObject({ state: "partial", datasetIds: [] });
      expect(batch.sourceIds).toHaveLength(1);
      expect(batch.evidenceIds).toHaveLength(1);
      expect(batch.failures).toEqual([{ path: `${baseUrl}/403`, message: expect.stringMatching(/403/) }]);

      const graph = await store.transaction(async (repos) => ({
        source: await repos.sources.get(batch.sourceIds[0]!, "workspace-1"),
        evidence: await repos.evidence.get(batch.evidenceIds[0]!, "workspace-1") as Evidence,
        audit: await repos.audit.listForEntity("workspace-1", "ingestion_batch", batch.id),
      }));
      expect(graph.source).toMatchObject({
        type: "link",
        ownership: "external_public",
        metadata: { provider: "playwright", finalUrl: `${baseUrl}/dynamic` },
      });
      expect(graph.evidence).toMatchObject({
        sourceLocator: `${baseUrl}/dynamic`,
        classification: "external_observation",
        toolHealth: { purpose: "tool_health", capabilityId: "playwright", healthy: true },
      });
      expect(graph.audit).toHaveLength(1);
      const assets = graph.evidence.assets!;
      expect(assets.map((asset) => asset.kind)).toEqual(["page_text", "screenshot"]);
      const textAsset = await service.getEvidenceAsset({
        workspaceId: "workspace-1",
        evidenceId: batch.evidenceIds[0]!,
        assetId: assets[0]!.id,
      });
      expect(JSON.parse(textAsset.content.toString("utf8"))).toMatchObject({
        text: expect.stringContaining("Client-only campaign detail"),
        fields: { headline: "Rendered by Chromium" },
      });
      const imageAsset = await service.getEvidenceAsset({
        workspaceId: "workspace-1",
        evidenceId: batch.evidenceIds[0]!,
        assetId: assets[1]!.id,
      });
      expect(imageAsset.content.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(imageAsset.content.length).toBe(assets[1]!.byteLength);

      const hits = documentHits;
      await expect(service.ingestContentLinks(command)).resolves.toEqual(batch);
      expect(documentHits).toBe(hits);
    } finally {
      store.close();
      await removeTempDir(artifactRoot);
    }
  }, 20_000);

  it("runs a real bounded multi-page session without requesting off-scope or duplicate links", async () => {
    const hits: string[] = [];
    const researchServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      hits.push(path);
      const port = (researchServer.address() as AddressInfo).port;
      const links: Record<string, string> = {
        "/research/start": `<a href="/research/child#first">child</a><a href="/research/start#cycle">cycle</a><a href="http://localhost:${port}/research/off-host">off host</a><a href="/outside">off path</a>`,
        "/research/child": `<a href="/research/child#duplicate">duplicate</a><a href="/research/grand">grand</a>`,
        "/research/grand": "leaf",
        "/outside": "must not be acquired",
      };
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><head><title>${path}</title></head><body>${links[path] ?? "not found"}</body></html>`);
    });
    const researchBase = await serve(researchServer);
    const store = openStore(":memory:");
    const artifactRoot = await createTempDir();
    let sequence = 0;
    const service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `bounded-${++sequence}` },
      new ArtifactStore(artifactRoot),
      undefined,
      new AcquisitionRouter({ playwright: playwright() }),
    );
    try {
      await store.transaction((repos) => repos.workspaces.insert({
        id: "workspace-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, name: "Workspace",
      }));
      const created = await service.createResearchSession({
        input: {
          id: "bounded-session",
          workspaceId: "workspace-1",
          goal: "Inspect bounded public pages",
          seeds: [`${researchBase}/research/start#seed`],
          expansion: true,
          scope: {
            hosts: ["127.0.0.1"], pathPrefixes: ["/research"], maxDepth: 2,
            maxPages: 2, maxDurationMs: 15_000, maxBytes: 20 * 1024 * 1024,
          },
        },
        context: { actor: "agent-1", requestId: "request-bounded-create", idempotencyKey: "command-bounded-create" },
      });
      await service.setResearchPermission({
        input: { id: created.id, workspaceId: "workspace-1", expectedVersion: 1, expansion: "allowed" },
        context: { actor: "agent-1", requestId: "request-bounded-allow", idempotencyKey: "command-bounded-allow" },
      });
      const result = await service.runResearch({
        input: { id: created.id, workspaceId: "workspace-1", expectedVersion: 2, limits: {} },
        context: { actor: "agent-1", requestId: "request-bounded-run", idempotencyKey: "command-bounded-run" },
      });

      expect(result.gaps).toEqual([]);
      expect(result).toMatchObject({ state: "partial", stopReason: "max_pages" });
      expect(result.evidenceIds).toHaveLength(2);
      expect(hits).toEqual(["/research/start", "/research/child"]);
    } finally {
      store.close();
      researchServer.closeAllConnections();
      await new Promise<void>((resolveClose) => researchServer.close(() => resolveClose()));
      await removeTempDir(artifactRoot);
    }
  }, 20_000);

  it("blocks out-of-scope redirects, subresources, and encoded paths before either real host is requested", async () => {
    const primaryHits: string[] = [];
    const otherHits: string[] = [];
    const otherServer = createServer((request, response) => {
      otherHits.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("globalThis.outOfScopeExecuted = true");
    });
    const otherBase = await serve(otherServer);
    const primaryServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      primaryHits.push(request.url ?? "");
      if (path === "/research/redirect-host") {
        response.writeHead(302, { location: `${otherBase.replace("127.0.0.1", "localhost")}/research/redirected` });
        response.end();
        return;
      }
      if (path === "/research/redirect-path") {
        response.writeHead(302, { location: "/outside-redirect" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body>Scoped start<script src="${otherBase.replace("127.0.0.1", "localhost")}/research/off-host.js"></script><img src="/outside-subresource"><img src="/research/%2foutside-encoded"><img src="/research/%2e%2e/outside-dot"></body></html>`);
    });
    const primaryBase = await serve(primaryServer);
    const provider = new PlaywrightAcquisitionProvider({ allowlist: ["127.0.0.1", "localhost"] });
    const scope = { hosts: ["127.0.0.1"], pathPrefixes: ["/research"] };
    try {
      const page = await provider.acquire({ url: `${primaryBase}/research/start`, scope } as never);
      expect(page.text).toContain("Scoped start");
      expect(otherHits).toEqual([]);
      expect(primaryHits).toEqual(["/research/start"]);

      await expect(provider.acquire({ url: `${primaryBase}/research/redirect-host`, scope } as never))
        .rejects.toMatchObject({ details: { reason: "scope_denied" } });
      await expect(provider.acquire({ url: `${primaryBase}/research/redirect-path`, scope } as never))
        .rejects.toMatchObject({ details: { reason: "scope_denied" } });
      await expect(provider.acquire({ url: `${primaryBase}/research/%2foutside`, scope } as never))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(otherHits).toEqual([]);
      expect(primaryHits).toEqual(["/research/start", "/research/redirect-host", "/research/redirect-path"]);
    } finally {
      primaryServer.closeAllConnections();
      otherServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolveClose) => primaryServer.close(() => resolveClose())),
        new Promise<void>((resolveClose) => otherServer.close(() => resolveClose())),
      ]);
    }
  }, 20_000);

  it("rejects an over-budget text candidate before fields or screenshot processing", async () => {
    let screenshotCalls = 0;
    const provider = new PlaywrightAcquisitionProvider({
      allowlist: ["127.0.0.1"],
      captureScreenshot: async () => {
        screenshotCalls += 1;
        return new Uint8Array();
      },
    });

    await expect(provider.acquire({
      url: `${baseUrl}/dynamic`, fields: { headline: "#headline" }, maxBytes: 1,
    } as never)).rejects.toMatchObject({ details: { reason: "max_bytes" } });
    expect(screenshotCalls).toBe(0);
  }, 20_000);

  it("applies one hard deadline across MCP and Playwright fallback", async () => {
    const delayedPage = {
      url: `${baseUrl}/dynamic`, finalUrl: `${baseUrl}/dynamic`, title: "late", text: "late",
      fields: {}, screenshot: Buffer.from("late"), provider: "playwright" as const, toolVersion: "fake",
    };
    const mcp = {
      acquire: async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        throw new DomainError("CAPABILITY_UNAVAILABLE", "MCP unavailable");
      },
    };
    const fallback = {
      acquire: async (request: { signal?: AbortSignal }) => {
        await new Promise<void>((resolveWait, rejectWait) => {
          const timer = setTimeout(resolveWait, 50);
          request.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            rejectWait(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
        return delayedPage;
      },
    };
    const router = new AcquisitionRouter({ mcp, playwright: fallback });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    try {
      await expect(router.acquire({
        url: `${baseUrl}/dynamic`, timeoutMs: 30, deadlineMs: started + 30, signal: controller.signal,
      } as never)).rejects.toMatchObject({ details: { reason: "max_duration" } });
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      clearTimeout(timer);
    }
  });

  it("aborts an active Playwright navigation at the remaining session deadline", async () => {
    const slowServer = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><body>Too late</body></html>");
      }, 200);
    });
    const slowBase = await serve(slowServer);
    const provider = new PlaywrightAcquisitionProvider({ allowlist: ["127.0.0.1"] });
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(provider.acquire({
        url: slowBase, timeoutMs: 30, deadlineMs: started + 30, signal: controller.signal,
      } as never)).rejects.toMatchObject({ details: { reason: "max_duration" } });
      expect(Date.now() - started).toBeLessThan(150);
    } finally {
      clearTimeout(timer);
      slowServer.closeAllConnections();
      await new Promise<void>((resolveClose) => slowServer.close(() => resolveClose()));
    }
  }, 20_000);
});

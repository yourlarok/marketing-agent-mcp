import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  SafeHttpClient,
  SafeHttpError,
  type SafeHttpLookup,
} from "../../src/infrastructure/safe-http.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const future = "2026-10-26T13:00:00.000Z";
const now = "2026-10-26T12:30:00.000Z";
const secret = "temporary-api-secret-that-must-not-leak";
const servers: Server[] = [];

async function serve(
  handler: Parameters<typeof createServer>[0],
): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

function client(options: {
  allowlist?: string[];
  credentialAllowlist?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  lookup?: SafeHttpLookup;
} = {}): SafeHttpClient {
  return new SafeHttpClient({
    allowlist: ["127.0.0.1"],
    now: () => now,
    ...options,
  });
}

function request(url: string, credentialRef?: string) {
  return { url, expiresAt: future, ...(credentialRef ? { credentialRef } : {}) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("SafeHttpClient", () => {
  it("reads JSON and CSV response bytes with their content types", async () => {
    const json = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify([{ name: "Acme", amount: 12 }]));
    });
    const csv = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/csv" });
      response.end("name,amount\nAcme,12\n");
    });

    const jsonResponse = await client().get(request(`${json.url}/data`));
    expect(jsonResponse.body.toString("utf8")).toBe('[{"name":"Acme","amount":12}]');
    expect(jsonResponse.contentType).toBe("application/json; charset=utf-8");
    const csvResponse = await client().get(request(`${csv.url}/data`));
    expect(csvResponse.body.toString("utf8")).toBe("name,amount\nAcme,12\n");
    expect(csvResponse.contentType).toBe("text/csv");
  });

  it("sends GET with a bearer token resolved only from an allowed environment reference", async () => {
    let observed: { method?: string; authorization?: string } = {};
    const server = await serve((incoming, response) => {
      observed = { method: incoming.method, authorization: incoming.headers.authorization };
      response.end("ok");
    });
    const http = client({
      credentialAllowlist: ["TEMPORARY_API_TOKEN"],
      env: { TEMPORARY_API_TOKEN: secret },
    });

    await http.get(request(`${server.url}/data`, "env:TEMPORARY_API_TOKEN"));

    expect(observed).toEqual({ method: "GET", authorization: `Bearer ${secret}` });
  });

  it("rejects expired requests before network I/O", async () => {
    const server = await serve((_request, response) => response.end("unexpected"));

    await expect(client().get({
      url: `${server.url}/data`,
      expiresAt: now,
    })).rejects.toThrow(/expired/i);
    expect(server.hits()).toBe(0);
  });

  it("rejects unknown environment references without leaking credential material", async () => {
    const server = await serve((_request, response) => response.end("unexpected"));
    const http = client({
      credentialAllowlist: ["ALLOWED_TOKEN"],
      env: { ALLOWED_TOKEN: secret },
    });

    await expect(http.get(request(`${server.url}/data`, "env:UNKNOWN_TOKEN")))
      .rejects.toThrow(/credential/i);
    const missing = client({ credentialAllowlist: ["ALLOWED_TOKEN"], env: {} });
    await expect(missing.get(request(`${server.url}/data`, "env:ALLOWED_TOKEN")))
      .rejects.toThrow(/environment/i);
    expect(server.hits()).toBe(0);
  });

  it("rejects plaintext and malformed credential references", async () => {
    const server = await serve((_request, response) => response.end("unexpected"));
    const http = client({ credentialAllowlist: ["ALLOWED_TOKEN"] });

    for (const credentialRef of [secret, "ALLOWED_TOKEN", "env:allowed_token", "env:BAD-NAME"]) {
      await expect(http.get(request(`${server.url}/data`, credentialRef)))
        .rejects.toThrow(/credentialRef/i);
    }
    expect(server.hits()).toBe(0);
  });

  it.each([401, 403, 429])("rejects HTTP %i without exposing the bearer token", async (status) => {
    const server = await serve((_request, response) => {
      response.writeHead(status);
      response.end(secret);
    });
    const http = client({
      credentialAllowlist: ["TEMPORARY_API_TOKEN"],
      env: { TEMPORARY_API_TOKEN: secret },
    });

    let error: unknown;
    try {
      await http.get(request(`${server.url}/data`, "env:TEMPORARY_API_TOKEN"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SafeHttpError);
    expect((error as Error).message).toContain(String(status));
    expect((error as Error).message).not.toContain(secret);
  });

  it("times out a stalled request", async () => {
    const server = await serve(() => {});

    await expect(client({ timeoutMs: 25 }).get(request(`${server.url}/stalled`)))
      .rejects.toThrow(/timed out/i);
  });

  it("times out while DNS resolution is stalled", async () => {
    const lookup: SafeHttpLookup = () => new Promise(() => {});
    const http = client({ timeoutMs: 25, lookup });

    await expect(http.get(request("http://stalled-dns.example/data"))).rejects.toThrow(/timed out/i);
  });

  it("rejects an oversized declared response before reading its body", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-length": String(10 * 1024 * 1024 + 1) });
      response.end();
    });

    await expect(client().get(request(`${server.url}/large`))).rejects.toThrow(/10 MiB/i);
  });

  it("rejects an oversized chunked response while streaming", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(10 * 1024 * 1024));
      response.end("x");
    });

    await expect(client().get(request(`${server.url}/large`))).rejects.toThrow(/10 MiB/i);
  });

  it("follows redirects explicitly and retains auth only for the same origin", async () => {
    let authorization: string | undefined;
    const server = await serve((incoming, response) => {
      if (incoming.url === "/start") {
        response.writeHead(302, { location: "/next" });
        response.end();
        return;
      }
      authorization = incoming.headers.authorization;
      response.end("done");
    });
    const http = client({
      credentialAllowlist: ["TEMPORARY_API_TOKEN"],
      env: { TEMPORARY_API_TOKEN: secret },
    });

    const result = await http.get(request(`${server.url}/start`, "env:TEMPORARY_API_TOKEN"));

    expect(result.body.toString("utf8")).toBe("done");
    expect(result.finalUrl).toBe(`${server.url}/next`);
    expect(authorization).toBe(`Bearer ${secret}`);
  });

  it("strips authorization on a cross-origin redirect", async () => {
    let authorization: string | undefined;
    const target = await serve((incoming, response) => {
      authorization = incoming.headers.authorization;
      response.end("done");
    });
    const source = await serve((_request, response) => {
      response.writeHead(307, { location: `${target.url}/target` });
      response.end();
    });
    const http = client({
      credentialAllowlist: ["TEMPORARY_API_TOKEN"],
      env: { TEMPORARY_API_TOKEN: secret },
    });

    await http.get(request(`${source.url}/start`, "env:TEMPORARY_API_TOKEN"));

    expect(authorization).toBeUndefined();
  });

  it("validates every redirect destination", async () => {
    const source = await serve((_request, response) => {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    });

    await expect(client().get(request(`${source.url}/start`))).rejects.toThrow(/not allowed/i);
  });

  it("rejects non-HTTP schemes and userinfo before network I/O", async () => {
    for (const url of ["file:///etc/passwd", "http://user:password@127.0.0.1/data"]) {
      await expect(client().get(request(url))).rejects.toThrow(/URL|userinfo/i);
    }
  });

  it("rejects private, loopback, and link-local destinations unless explicitly allowlisted", async () => {
    const http = client({ allowlist: [] });
    for (const url of [
      "http://127.0.0.1/data",
      "http://10.0.0.8/data",
      "http://169.254.169.254/data",
      "http://[::1]/data",
      "http://[fe80::1]/data",
    ]) {
      await expect(http.get(request(url))).rejects.toThrow(/not allowed/i);
    }
  });

  it("rejects a hostname whose DNS answers change to a private address", async () => {
    const lookup: SafeHttpLookup = async () => ["93.184.216.34", "127.0.0.1"];
    const http = client({ allowlist: [], lookup });

    await expect(http.get(request("http://rebind.example/data"))).rejects.toThrow(/not allowed/i);
  });

  it("connects to the address validated during DNS resolution", async () => {
    const server = await serve((_request, response) => response.end("pinned"));
    const port = new URL(server.url).port;
    const lookup: SafeHttpLookup = async (hostname) => {
      expect(hostname).toBe("rebind.test");
      return ["127.0.0.1"];
    };
    const http = client({ allowlist: ["rebind.test"], lookup });

    const result = await http.get(request(`http://rebind.test:${port}/data`));

    expect(result.body.toString("utf8")).toBe("pinned");
  });

  it("loads explicit destination and credential-name allowlists from configuration", async () => {
    const root = await createTempDir();
    try {
      expect(loadConfig({
        MARKETING_DATA_DIR: root,
        MARKETING_HTTP_ALLOWLIST: "127.0.0.1, localhost",
        MARKETING_HTTP_CREDENTIAL_ALLOWLIST: "FIRST_TOKEN,SECOND_TOKEN",
      })).toEqual({
        dataDir: root,
        logLevel: "info",
        httpAllowlist: ["127.0.0.1", "localhost"],
        httpCredentialAllowlist: ["FIRST_TOKEN", "SECOND_TOKEN"],
      });
    } finally {
      await removeTempDir(root);
    }
  });
});

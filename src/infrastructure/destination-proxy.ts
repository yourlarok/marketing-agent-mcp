import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { DomainError } from "../domain/errors.js";
import { assertAcquisitionUrlInScope, type AcquisitionScope } from "./acquisition-policy.js";
import { isBlockedAddress } from "./safe-http.js";

export interface DestinationValidatorOptions {
  allowlist?: string[];
  lookup?: (hostname: string) => Promise<string[]>;
}

export interface ValidatedDestination {
  url: URL;
  address: string;
  port: number;
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

export class DestinationValidator {
  private readonly allowlist: Set<string>;
  private readonly lookup: (hostname: string) => Promise<string[]>;

  constructor(options: DestinationValidatorOptions = {}) {
    this.allowlist = new Set((options.allowlist ?? []).map(normalizedHostname));
    this.lookup = options.lookup ?? (async (hostname) => {
      const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
      return addresses.map((entry) => entry.address);
    });
  }

  async validate(raw: string, scope?: AcquisitionScope): Promise<ValidatedDestination> {
    assertAcquisitionUrlInScope(raw, scope);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw denied("Content acquisition destination is invalid");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw denied("Content acquisition destination must use HTTP or HTTPS without userinfo");
    }
    const hostname = normalizedHostname(url.hostname);
    let addresses: string[];
    try {
      addresses = isIPv4(hostname) || isIPv6(hostname) ? [hostname] : await this.lookup(hostname);
    } catch {
      throw denied("Content acquisition destination could not be resolved");
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      if (!this.allowlist.has(hostname)) {
        throw denied("Content acquisition destination is not allowed");
      }
    }
    const address = addresses[0];
    if (!address || (!isIPv4(address) && !isIPv6(address))) {
      throw denied("Content acquisition destination address is invalid");
    }
    return {
      url,
      address,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    };
  }
}

function denied(message: string): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, false, { reason: "destination_denied" });
}

export class DestinationPinningProxy {
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  private constructor(
    private readonly validator: DestinationValidator,
    private readonly timeoutMs: number,
    private readonly scope?: AcquisitionScope,
  ) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.setTimeout(this.timeoutMs, () => socket.destroy());
      this.receiveRequest(socket);
    });
  }

  static async start(validator: DestinationValidator, timeoutMs: number, scope?: AcquisitionScope): Promise<DestinationPinningProxy> {
    const proxy = new DestinationPinningProxy(validator, timeoutMs, scope);
    await new Promise<void>((resolveListen, rejectListen) => {
      const listening = (): void => {
        proxy.server.off("error", rejectListen);
        resolveListen();
      };
      proxy.server.once("error", rejectListen);
      proxy.server.listen(0, "127.0.0.1", listening);
    });
    return proxy;
  }

  get url(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private receiveRequest(client: Socket): void {
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 32_768) {
        client.destroy();
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      client.off("data", onData);
      const head = header.subarray(0, end).toString("latin1");
      const remainder = header.subarray(end + 4);
      void this.forward(client, head, remainder).catch(() => {
        rejectSocket(client, 502);
      });
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  }

  private async forward(client: Socket, head: string, remainder: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const [method = "", target = "", version = "HTTP/1.1"] = lines[0]?.split(" ") ?? [];
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0) {
        headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
      }
    }
    if (headers.get("upgrade")?.toLowerCase() === "websocket") {
      rejectSocket(client, 403);
      return;
    }
    const connectRequest = method.toUpperCase() === "CONNECT";
    const rawUrl = connectRequest ? `https://${target}` : target;
    if (!connectRequest && !rawUrl.startsWith("http://")) {
      rejectSocket(client, 403);
      return;
    }
    const requestScope = connectRequest && this.scope
      ? { hosts: this.scope.hosts, pathPrefixes: ["/"] }
      : this.scope;
    const destination = await this.validator.validate(rawUrl, requestScope);
    if (connectRequest && destination.url.pathname !== "/" && destination.url.pathname !== "") {
      rejectSocket(client, 403);
      return;
    }
    const upstream = connect({
      host: destination.address,
      port: destination.port,
      family: isIPv6(destination.address) ? 6 : 4,
    });
    this.sockets.add(upstream);
    upstream.on("close", () => this.sockets.delete(upstream));
    upstream.setTimeout(this.timeoutMs, () => {
      upstream.destroy();
      client.destroy();
    });
    upstream.on("error", () => rejectSocket(client, 502));
    await new Promise<void>((resolveConnect, rejectConnect) => {
      upstream.once("connect", resolveConnect);
      upstream.once("error", rejectConnect);
    });
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    if (connectRequest) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } else {
      const path = `${destination.url.pathname}${destination.url.search}`;
      const outgoing = lines.slice(1).filter((line) => {
        const name = line.split(":", 1)[0]?.trim().toLowerCase();
        return name !== "proxy-connection" && name !== "connection";
      });
      client.pause();
      upstream.write(`${method} ${path} ${version}\r\n${outgoing.join("\r\n")}\r\nConnection: close\r\n\r\n`);
    }
    if (remainder.length > 0) {
      upstream.write(remainder);
    }
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }
}

function rejectSocket(socket: Socket, status: number): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
  }
}

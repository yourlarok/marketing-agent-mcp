import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { parseCommaSeparatedList } from "../config.js";

export const SAFE_HTTP_MAX_BYTES = 10 * 1024 * 1024;
export const SAFE_HTTP_TIMEOUT_MS = 10_000;

export type SafeHttpLookup = (hostname: string) => Promise<string[]>;

export interface SafeHttpRequest {
  url: string;
  expiresAt: string;
  credentialRef?: string;
}

export interface SafeHttpResponse {
  body: Buffer;
  contentType?: string;
  finalUrl: string;
}

export interface SafeHttpClientOptions {
  allowlist?: string[];
  credentialAllowlist?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  timeoutMs?: number;
  lookup?: SafeHttpLookup;
}

export class SafeHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeHttpError";
  }
}

const defaultLookup: SafeHttpLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(address: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (ipv4Number(base) & mask);
}

function expandedIpv6(address: string): number[] {
  const withoutZone = address.split("%")[0]!;
  const mapped = withoutZone.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
  const input = mapped
    ? `${mapped[1]}:${((ipv4Number(mapped[2]!) >>> 16) & 0xffff).toString(16)}:${(ipv4Number(mapped[2]!) & 0xffff).toString(16)}`
    : withoutZone;
  const halves = input.split("::");
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const parts = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return parts.map((part) => Number.parseInt(part || "0", 16));
}

export function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  if (isIPv4(normalized)) {
    const value = ipv4Number(normalized);
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["224.0.0.0", 4],
    ].some(([base, bits]) => inIpv4Range(value, base as string, bits as number));
  }
  if (!isIPv6(normalized)) {
    return true;
  }
  const parts = expandedIpv6(normalized);
  if (parts.length !== 8) {
    return true;
  }
  const first = parts[0]!;
  const mappedIpv4 = parts.slice(0, 6).every((part, index) =>
    index < 5 ? part === 0 : part === 0xffff
  );
  if (mappedIpv4) {
    const value = ((parts[6]! << 16) + parts[7]!) >>> 0;
    const address4 = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
    return isBlockedAddress(address4);
  }
  return parts.every((part) => part === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1);
}

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeHttpError("Temporary API URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeHttpError("Temporary API URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new SafeHttpError("Temporary API URL userinfo is not allowed");
  }
  return url;
}

function origin(url: URL): string {
  return url.origin;
}

export class SafeHttpClient {
  private readonly allowlist: Set<string>;
  private readonly credentialAllowlist: Set<string>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly lookup: SafeHttpLookup;

  constructor(options: SafeHttpClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.allowlist = new Set(
      (options.allowlist ?? parseCommaSeparatedList(this.env.MARKETING_HTTP_ALLOWLIST))
        .map(normalizedHostname),
    );
    this.credentialAllowlist = new Set(
      options.credentialAllowlist ?? parseCommaSeparatedList(this.env.MARKETING_HTTP_CREDENTIAL_ALLOWLIST),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = Math.min(options.timeoutMs ?? SAFE_HTTP_TIMEOUT_MS, SAFE_HTTP_TIMEOUT_MS);
    this.lookup = options.lookup ?? defaultLookup;
  }

  async get(input: SafeHttpRequest): Promise<SafeHttpResponse> {
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.parse(this.now())) {
      throw new SafeHttpError("Temporary API URL has expired or has an invalid expiry");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new SafeHttpError("Temporary API HTTP timeout is invalid");
    }
    const authorization = input.credentialRef === undefined
      ? undefined
      : this.resolveCredential(input.credentialRef);
    let current = validateUrl(input.url);
    let forwardAuthorization = true;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      for (let redirects = 0; ; redirects += 1) {
        const addresses = await abortable(this.resolveAndValidate(current), controller.signal);
        const dispatcher = new Agent({
          connect: { lookup: pinnedLookup(addresses[0]!) },
        });
        try {
          const response = await request(current, {
            method: "GET",
            dispatcher,
            signal: controller.signal,
            headersTimeout: this.timeoutMs,
            bodyTimeout: this.timeoutMs,
            headers: authorization && forwardAuthorization ? { authorization } : {},
          });
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            discard(response.body);
            if (redirects >= 5 || !response.headers.location) {
              throw new SafeHttpError("Temporary API redirect is invalid or exceeds five hops");
            }
            const location = Array.isArray(response.headers.location)
              ? response.headers.location[0]
              : response.headers.location;
            if (!location) {
              throw new SafeHttpError("Temporary API redirect location is invalid");
            }
            const next = validateUrl(new URL(location, current).toString());
            forwardAuthorization &&= origin(current) === origin(next);
            current = next;
            continue;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            discard(response.body);
            throw new SafeHttpError(`Temporary API request failed with HTTP ${response.statusCode}`);
          }
          const declared = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(declared) && declared > SAFE_HTTP_MAX_BYTES) {
            discard(response.body);
            throw new SafeHttpError("Temporary API response exceeds 10 MiB");
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > SAFE_HTTP_MAX_BYTES) {
              discard(response.body);
              throw new SafeHttpError("Temporary API response exceeds 10 MiB");
            }
            chunks.push(buffer);
          }
          const contentType = response.headers["content-type"];
          return {
            body: Buffer.concat(chunks, bytes),
            ...(contentType ? { contentType: Array.isArray(contentType) ? contentType[0] : contentType } : {}),
            finalUrl: current.toString(),
          };
        } finally {
          await dispatcher.close();
        }
      }
    } catch (error) {
      if (error instanceof SafeHttpError) {
        throw error;
      }
      if (timedOut) {
        throw new SafeHttpError("Temporary API HTTP request timed out");
      }
      throw new SafeHttpError("Temporary API HTTP request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveCredential(reference: string): string {
    const match = /^env:([A-Z_][A-Z0-9_]*)$/.exec(reference);
    if (!match || !this.credentialAllowlist.has(match[1]!)) {
      throw new SafeHttpError("credentialRef must reference an allowed environment variable");
    }
    const value = this.env[match[1]!];
    if (!value || /[\r\n]/.test(value)) {
      throw new SafeHttpError("Temporary API credential environment variable is missing or invalid");
    }
    return `Bearer ${value}`;
  }

  private async resolveAndValidate(url: URL): Promise<string[]> {
    const hostname = normalizedHostname(url.hostname);
    let addresses: string[];
    try {
      addresses = isIPv4(hostname) || isIPv6(hostname) ? [hostname] : await this.lookup(hostname);
    } catch {
      throw new SafeHttpError("Temporary API destination could not be resolved");
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      if (!this.allowlist.has(hostname)) {
        throw new SafeHttpError("Temporary API destination is not allowed");
      }
    }
    return addresses;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function discard(body: { on(event: string, listener: () => void): void; destroy(): void }): void {
  body.on("error", () => undefined);
  body.destroy();
}

function pinnedLookup(address: string): LookupFunction {
  return (_hostname, options, callback) => {
    const family = isIPv6(address) ? 6 : 4;
    if (options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

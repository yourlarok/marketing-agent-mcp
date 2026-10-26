import { DomainError } from "../domain/errors.js";

export interface AcquisitionScope {
  hosts: string[];
  pathPrefixes: string[];
}

export interface AcquisitionPayload {
  text: string;
  fields: Record<string, string>;
  screenshot: Uint8Array;
}

function invalidPath(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function rawPath(value: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value);
  if (absolute) {
    return absolute[1] ?? "/";
  }
  return value.split(/[?#]/, 1)[0] ?? "";
}

function normalizedDecodedPath(raw: string): string {
  if (raw.includes("\\") || /%(?:2f|5c)/i.test(raw)) {
    invalidPath("Acquisition paths must not contain encoded separators or backslashes");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    invalidPath("Acquisition path encoding is invalid");
  }
  if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    invalidPath("Acquisition paths must not contain backslashes or dot segments");
  }
  return decoded;
}

export function normalizeAcquisitionPathPrefix(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#")) {
    invalidPath("scope.pathPrefixes must be absolute paths without query or fragment");
  }
  return normalizedDecodedPath(value);
}

export function canonicalAcquisitionUrl(value: unknown, base?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", "Acquisition URL must not be empty");
  }
  normalizedDecodedPath(rawPath(value));
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new DomainError("INVALID_INPUT", "Acquisition URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new DomainError("INVALID_INPUT", "Acquisition URL must be HTTP or HTTPS without userinfo");
  }
  normalizedDecodedPath(url.pathname);
  url.hash = "";
  return url.href;
}

export function isAcquisitionUrlInScope(value: string, scope: AcquisitionScope): boolean {
  try {
    const canonical = canonicalAcquisitionUrl(value);
    const url = new URL(canonical);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!scope.hosts.some((host) => host.toLowerCase().replace(/\.$/, "") === hostname)) {
      return false;
    }
    const path = normalizedDecodedPath(url.pathname);
    return scope.pathPrefixes.some((prefix) => {
      const normalizedPrefix = normalizeAcquisitionPathPrefix(prefix);
      return normalizedPrefix === "/" || path === normalizedPrefix ||
        path.startsWith(normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`);
    });
  } catch {
    return false;
  }
}

export function assertAcquisitionUrlInScope(value: string, scope?: AcquisitionScope): void {
  if (scope && !isAcquisitionUrlInScope(value, scope)) {
    throw new DomainError("CAPABILITY_UNAVAILABLE", "Acquisition destination is outside the research scope", false, {
      reason: "scope_denied",
    });
  }
}

export function acquisitionPayloadBytes(payload: AcquisitionPayload): number {
  let bytes = Buffer.byteLength(payload.text) + payload.screenshot.byteLength;
  for (const [name, value] of Object.entries(payload.fields)) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  return bytes;
}

export function assertAcquisitionPayloadBudget(payload: AcquisitionPayload, maxBytes?: number): number {
  const bytes = acquisitionPayloadBytes(payload);
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new DomainError("CAPABILITY_UNAVAILABLE", "Acquisition payload exceeds the remaining research byte budget", false, {
      reason: "max_bytes",
      payloadBytes: bytes,
      maxBytes,
    });
  }
  return bytes;
}

export function acquisitionDeadlineError(payloadBytes?: number): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", "Research acquisition deadline reached", false, {
    reason: "max_duration",
    ...(payloadBytes !== undefined && payloadBytes > 0 ? { payloadBytes } : {}),
  });
}

export function throwIfAcquisitionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw acquisitionDeadlineError();
  }
}

export async function raceWithAcquisitionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAcquisitionAborted(signal);
  if (!signal) {
    return promise;
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(acquisitionDeadlineError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

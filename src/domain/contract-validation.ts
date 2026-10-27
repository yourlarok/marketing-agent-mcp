import type { JsonValue } from "../application/ports.js";
import { DomainError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATABASE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertRecord(
  value: unknown,
  label: string,
  allowedKeys?: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || (allowedKeys !== undefined && !allowedKeys.includes(key))) {
      invalid(`${label} contains unsupported key: ${key}`);
    }
  }
}

export function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || FORBIDDEN_KEYS.has(value)) {
    invalid(`${label} must be a controlled identifier`);
  }
}

export function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value) ||
      FORBIDDEN_KEYS.has(value)) {
    invalid(`${label} must be a non-empty stable ID`);
  }
}

export function assertDatabaseId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    invalid("databaseId must be a safe relative identifier");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !DATABASE_SEGMENT.test(segment) || segment === "." || segment === "..")) {
    invalid("databaseId must be a safe relative identifier");
  }
}

export function assertNonEmptyStringArray(
  value: unknown,
  label: string,
  maximum = 1000,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    invalid(`${label} must be a non-empty bounded string array`);
  }
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`);
}

export function assertJsonValue(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} numbers must be finite`);
    return;
  }
  if (typeof value !== "object") invalid(`${label} must contain only JSON values`);
  if (seen.has(value)) invalid(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen);
  } else {
    assertRecord(value, label);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${label} objects must be plain JSON objects`);
    }
    for (const item of Object.values(value)) assertJsonValue(item, label, seen);
  }
  seen.delete(value);
}

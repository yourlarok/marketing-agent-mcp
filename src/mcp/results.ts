import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { MAX_SERIALIZED_OUTPUT_BYTES } from "./schemas.js";

export function toolOutputJson(value: unknown): string {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > MAX_SERIALIZED_OUTPUT_BYTES) {
    throw new DomainError("CONFLICT", "Tool output exceeds 64 KiB", false, {
      limitBytes: MAX_SERIALIZED_OUTPUT_BYTES,
    });
  }
  return text;
}

export function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: toolOutputJson(value) }] };
}

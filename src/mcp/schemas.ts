import { z } from "zod";

export const MAX_SERIALIZED_INPUT_BYTES = 64 * 1024;
export const MAX_COLLECTION_ENTRIES = 1_000;
export const MAX_KEY_LENGTH = 128;
export const MAX_ID_LENGTH = 256;

const secretKeyNames = [
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secrets",
  "token",
] as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SerializedInput = Record<string, JsonValue>;

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return secretKeyNames.some(
    (secretName) =>
      normalized === secretName ||
      normalized.endsWith(secretName) ||
      normalized.endsWith(`${secretName}s`),
  );
}

function checkObjectKeys(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (Object.keys(value).length > MAX_COLLECTION_ENTRIES) {
    context.addIssue({
      code: "too_big",
      maximum: MAX_COLLECTION_ENTRIES,
      origin: "object",
      inclusive: true,
      message: `Objects may contain at most ${MAX_COLLECTION_ENTRIES} entries`,
      input: value,
    });
  }

  for (const key of Object.keys(value)) {
    if (isSecretLikeKey(key)) {
      context.addIssue({
        code: "custom",
        message: "Secret-like fields are not allowed in tool input",
        path: [key],
        input: value,
      });
    }
  }
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(MAX_SERIALIZED_INPUT_BYTES),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(MAX_COLLECTION_ENTRIES),
    z
      .record(z.string().max(MAX_KEY_LENGTH), jsonValueSchema)
      .superRefine(checkObjectKeys),
  ]),
);

export const serializedInputSchema = z
  .record(z.string().max(MAX_KEY_LENGTH), jsonValueSchema)
  .superRefine(checkObjectKeys)
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SERIALIZED_INPUT_BYTES) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_SERIALIZED_INPUT_BYTES,
        origin: "string",
        inclusive: true,
        message: "Serialized tool input must not exceed 64 KiB",
        input: value,
      });
    }
  });

export const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
export const utcTimestampSchema = z.iso.datetime();

export const resourceIdInputSchema = z.strictObject({
  id: idSchema,
});

export const timestampInputSchema = z.strictObject({
  timestamp: utcTimestampSchema,
});

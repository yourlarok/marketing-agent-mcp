import { z } from "zod";
import { isSecretLikeKey } from "../domain/secrets.js";

export { isSecretLikeKey } from "../domain/secrets.js";

export const MAX_SERIALIZED_INPUT_BYTES = 64 * 1024;
export const MAX_COLLECTION_ENTRIES = 1_000;
export const MAX_KEY_LENGTH = 128;
export const MAX_ID_LENGTH = 256;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SerializedInput = Record<string, JsonValue>;

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

const serializedInputRecordSchema = z
  .record(z.string().max(MAX_KEY_LENGTH), jsonValueSchema)
  .superRefine(checkObjectKeys);

export const serializedInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value) as string | undefined;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Tool input must be serializable JSON",
        input: value,
      });
      return;
    }

    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_INPUT_BYTES
    ) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_SERIALIZED_INPUT_BYTES,
        origin: "string",
        inclusive: true,
        message: "Serialized tool input must not exceed 64 KiB",
        input: value,
      });
    }
  })
  .pipe(serializedInputRecordSchema);

export const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
export const utcTimestampSchema = z.iso.datetime();

export const resourceIdInputSchema = z.strictObject({
  id: idSchema,
});

export const timestampInputSchema = z.strictObject({
  timestamp: utcTimestampSchema,
});

const commandContextInput = {
  actor: idSchema,
  requestId: idSchema,
  idempotencyKey: idSchema,
};

export const createWorkspaceInputSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(1_024),
  metadata: jsonValueSchema.optional(),
  ...commandContextInput,
});

export const registerSourceInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().trim().min(1).max(1_024),
  type: z.enum(["file", "link", "api", "manual", "database"]),
  ownership: z.enum(["owned", "authorized", "external_public"]),
  metadata: jsonValueSchema.optional(),
  ...commandContextInput,
});

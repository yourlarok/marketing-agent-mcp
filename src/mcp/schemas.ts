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

export const registerCapabilityInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().trim().min(1).max(1_024),
  adapterKind: z.enum(["mcp", "api_cli", "script_adapter", "temporary_connector"]),
  origin: z.literal("user_extension"),
  configuration: jsonValueSchema.optional(),
  ...commandContextInput,
});

export const recordCapabilityHealthInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: z.number().int().positive(),
  healthy: z.boolean(),
  checkedAt: utcTimestampSchema,
  toolVersion: z.string().trim().min(1).max(1_024).optional(),
  evidenceId: idSchema.optional(),
  reason: z.string().trim().min(1).max(8_192).optional(),
  ...commandContextInput,
});

export const capabilityListInputSchema = z.strictObject({
  workspaceId: idSchema,
  adapterKind: z
    .enum(["mcp", "api_cli", "script_adapter", "temporary_connector"])
    .optional(),
  state: z.enum(["registered", "configured", "verified", "unavailable"]).optional(),
});

export const registerDatasetInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  sourceId: idSchema,
  name: z.string().trim().min(1).max(1_024),
  coverageStart: utcTimestampSchema,
  coverageEnd: utcTimestampSchema,
  fieldDefinitions: jsonValueSchema,
  metricDefinitions: jsonValueSchema,
  limitations: jsonValueSchema,
  ...commandContextInput,
});

export const recordEvidenceInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  sourceId: idSchema,
  sourceLocator: z.string().trim().min(1).max(4_096),
  observedAt: utcTimestampSchema,
  summary: z.string().trim().min(1).max(8_192),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i),
  classification: z.enum([
    "owned_operating",
    "owned_conversion",
    "external_observation",
  ]),
  toolHealth: z
    .strictObject({
      purpose: z.literal("tool_health"),
      capabilityId: idSchema,
      healthy: z.boolean(),
      checkedAt: utcTimestampSchema,
      toolVersion: z.string().trim().min(1).max(1_024),
    })
    .optional(),
  ...commandContextInput,
});

export const recordFindingInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  kind: z.enum(["fact", "inference", "unknown"]),
  statement: z.string().trim().min(1).max(8_192),
  evidenceIds: z
    .array(idSchema)
    .max(MAX_COLLECTION_ENTRIES)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Evidence IDs must not contain duplicates",
    }),
  limitations: z.string().trim().min(1).max(8_192).optional(),
  unknownReason: z.string().trim().min(1).max(8_192).optional(),
  ...commandContextInput,
});

const uniqueIdsSchema = z
  .array(idSchema)
  .max(MAX_COLLECTION_ENTRIES)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "IDs must not contain duplicates",
  });
const textListSchema = z
  .array(z.string().trim().min(1).max(8_192))
  .max(MAX_COLLECTION_ENTRIES);

export const createRecommendationInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  findingIds: uniqueIdsSchema.min(1),
  hypothesis: z.string().trim().min(1).max(8_192),
  affectedStage: z.string().trim().min(1).max(1_024),
  priority: z.string().trim().min(1).max(1_024),
  expectedMetric: z.string().trim().min(1).max(1_024),
  ...commandContextInput,
});

export const createTaskInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  recommendationIds: uniqueIdsSchema.min(1),
  assignee: z.string().trim().min(1).max(1_024),
  dependencyIds: uniqueIdsSchema,
  assetRequirements: textListSchema,
  acceptanceCriteria: textListSchema.min(1),
  ...commandContextInput,
});

export const transitionTaskInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  next: z.enum(["draft", "ready", "in_progress", "blocked", "completed"]),
  expectedVersion: z.number().int().positive(),
  ...commandContextInput,
});

export const lineageGetInputSchema = z.strictObject({
  entityType: z.enum([
    "source",
    "dataset",
    "evidence",
    "finding",
    "recommendation",
    "task",
  ]),
  id: idSchema,
  workspaceId: idSchema,
});

const questionTypeSchema = z.enum([
  "content_performance",
  "lead_funnel",
  "conversion",
  "competitor_content",
]);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const stringListSchema = z.array(z.string().trim().min(1).max(8_192)).max(MAX_COLLECTION_ENTRIES);
const freshnessSchema = z.strictObject({
  observedAt: utcTimestampSchema.optional(),
  evaluatedAt: utcTimestampSchema.optional(),
  maxAgeHours: z.number().positive().finite().optional(),
});
const ingestLimitsSchema = z.strictObject({
  maxFileBytes: positiveIntegerSchema.optional(),
  maxFiles: positiveIntegerSchema.optional(),
  maxRows: positiveIntegerSchema.optional(),
  maxColumns: positiveIntegerSchema.optional(),
});
const parsedFileBatchSchema = z.strictObject({
  datasets: z.array(z.strictObject({
    source: z.strictObject({
      path: z.string().min(1).max(8_192),
      fileName: z.string().min(1).max(1_024),
      format: z.enum(["csv", "xlsx"]),
      sizeBytes: nonNegativeIntegerSchema,
      sheetName: z.string().min(1).max(1_024).optional(),
    }),
    fields: z.array(z.strictObject({
      name: z.string().max(1_024),
      index: nonNegativeIntegerSchema,
      inferredType: z.enum(["empty", "string", "number", "boolean", "mixed"]),
    })).max(MAX_COLLECTION_ENTRIES),
    rowsJsonl: z.string().max(MAX_SERIALIZED_INPUT_BYTES),
    quality: z.strictObject({
      rowCount: nonNegativeIntegerSchema,
      columnCount: nonNegativeIntegerSchema,
      duplicateRowCount: nonNegativeIntegerSchema,
      emptyRowCount: nonNegativeIntegerSchema,
      typeInconsistencyCount: nonNegativeIntegerSchema,
    }),
    issues: z.array(z.strictObject({
      code: z.enum([
        "DUPLICATE_HEADER",
        "EMPTY_HEADER",
        "INCONSISTENT_COLUMNS",
        "DUPLICATE_ROW",
        "TYPE_INCONSISTENCY",
        "MISSING_CACHED_FORMULA_RESULT",
      ]),
      message: z.string().min(1).max(8_192),
      rowNumber: positiveIntegerSchema.optional(),
      columnNumber: positiveIntegerSchema.optional(),
    })).max(MAX_COLLECTION_ENTRIES),
  })).max(MAX_COLLECTION_ENTRIES),
});

export const dataRequestPlanInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  objective: z.string().trim().min(1).max(MAX_SERIALIZED_INPUT_BYTES),
  questionTypes: z.array(questionTypeSchema).min(1).max(4),
  availableFields: stringListSchema,
  batch: parsedFileBatchSchema.optional(),
  freshness: freshnessSchema.optional(),
  ...commandContextInput,
});

export const dataRequestDeclineInputSchema = z.strictObject({
  planId: idSchema,
  workspaceId: idSchema,
  expectedPlanVersion: positiveIntegerSchema,
  questionType: questionTypeSchema,
  reason: z.string().trim().min(1).max(8_192),
  ...commandContextInput,
});

export const ingestFilesInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  paths: z.array(z.string().trim().min(1).max(8_192)).min(1).max(100),
  limits: ingestLimitsSchema.optional(),
  planId: idSchema.optional(),
  expectedPlanVersion: positiveIntegerSchema.optional(),
  freshness: freshnessSchema.optional(),
  ...commandContextInput,
});

export const ingestTemporaryApiInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  url: z.string().trim().min(1).max(4_096),
  ownership: z.enum(["owned", "authorized"]),
  expiresAt: utcTimestampSchema,
  credentialRef: z.string().trim().min(1).max(1_024).optional(),
  limits: ingestLimitsSchema.optional(),
  planId: idSchema.optional(),
  expectedPlanVersion: positiveIntegerSchema.optional(),
  freshness: freshnessSchema.optional(),
  ...commandContextInput,
});

export const ingestContentLinksInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  links: z.array(z.strictObject({
    url: z.string().trim().min(1).max(4_096),
    fields: z.record(z.string().max(MAX_KEY_LENGTH), z.string().min(1).max(1_000)).optional(),
  })).min(1).max(100),
  ...commandContextInput,
});

const researchLimitsSchema = z.strictObject({
  maxDepth: nonNegativeIntegerSchema,
  maxPages: positiveIntegerSchema,
  maxDurationMs: positiveIntegerSchema,
  maxBytes: positiveIntegerSchema,
});

export const researchSessionCreateInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  goal: z.string().trim().min(1).max(8_192),
  seeds: z.array(z.string().trim().min(1).max(4_096)).min(1).max(100),
  expansion: z.boolean(),
  scope: researchLimitsSchema.extend({
    hosts: z.array(z.string().trim().min(1).max(1_024)).min(1).max(100),
    pathPrefixes: z.array(z.string().trim().min(1).max(4_096)).min(1).max(100),
  }),
  ...commandContextInput,
});

export const researchPermissionSetInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  expansion: z.enum(["allowed", "denied"]),
  ...commandContextInput,
});

export const researchSessionRunInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  limits: researchLimitsSchema.partial().optional(),
  ...commandContextInput,
});

export const competitorConfirmInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  status: z.enum(["confirmed", "excluded"]),
  ...commandContextInput,
});

export const competitorDiffCreateInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  competitorIds: z.tuple([idSchema, idSchema]),
  dimensions: stringListSchema.min(1),
  ...commandContextInput,
});

export const dataResearchGetInputSchema = z.strictObject({
  entityType: z.enum([
    "data_request_plan",
    "ingestion_batch",
    "research_session",
    "competitor",
    "competitor_diff",
  ]),
  id: idSchema,
  workspaceId: idSchema,
});

export const evidenceAssetGetInputSchema = z.strictObject({
  workspaceId: idSchema,
  evidenceId: idSchema,
  assetId: idSchema,
});

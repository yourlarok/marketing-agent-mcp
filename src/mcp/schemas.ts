import { z } from "zod";
import { isSecretLikeKey } from "../domain/secrets.js";

export { isSecretLikeKey } from "../domain/secrets.js";

export const MAX_SERIALIZED_INPUT_BYTES = 64 * 1024;
export const MAX_SERIALIZED_OUTPUT_BYTES = 64 * 1024;
export const MAX_COLLECTION_ENTRIES = 1_000;
export const MAX_KEY_LENGTH = 128;
export const MAX_ID_LENGTH = 256;
export const MAX_ANALYSIS_NODE_REFERENCE_LENGTH = MAX_ID_LENGTH * 2;

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
  ownership: z.enum(["owned", "authorized", "external_public"]).optional(),
  limits: ingestLimitsSchema.optional(),
  planId: idSchema.optional(),
  expectedPlanVersion: positiveIntegerSchema.optional(),
  freshness: freshnessSchema.optional(),
  ...commandContextInput,
});

const connectorIdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const connectorDatabaseIdSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/)
  .refine((value) => value.split("/").every((segment) => segment !== "." && segment !== ".."));
const connectorScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const structuredTableQueryInputSchema = z.strictObject({
  databaseId: connectorDatabaseIdSchema,
  table: connectorIdentifierSchema,
  columns: z.array(connectorIdentifierSchema).min(1).max(500)
    .refine((columns) => new Set(columns).size === columns.length),
  filters: z.record(connectorIdentifierSchema, connectorScalarSchema),
  order: z.array(z.strictObject({
    column: connectorIdentifierSchema,
    direction: z.enum(["asc", "desc"]),
  })).max(500).refine((orders) =>
    new Set(orders.map((order) => order.column)).size === orders.length),
  limit: z.number().int().min(1).max(100_000),
});

export const connectorSqliteDiscoverInputSchema = z.strictObject({
  databaseId: connectorDatabaseIdSchema,
});
export const ingestSqliteInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  query: structuredTableQueryInputSchema,
  ownership: z.enum(["owned", "authorized"]),
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

const analysisComparabilitySchema = z.enum(["not_assessed", "comparable", "not_comparable"]);
const analysisPayloadSchema = z
  .record(z.string().max(MAX_KEY_LENGTH), jsonValueSchema)
  .superRefine(checkObjectKeys);
const analysisNodeReferenceSchema = z.string().trim().min(1).max(MAX_ANALYSIS_NODE_REFERENCE_LENGTH);
const analysisNodeSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["question", "research", "dataset", "metric", "scenario", "monitor", "decision"]),
  payload: analysisPayloadSchema,
});
const analysisEdgeSchema = z.strictObject({
  id: idSchema,
  fromNodeId: analysisNodeReferenceSchema,
  toNodeId: analysisNodeReferenceSchema,
});
const analysisRecommendedActionSchema = z.strictObject({
  tool: z.string().trim().min(1).max(1_024),
  description: z.string().trim().min(1).max(8_192),
  arguments: analysisPayloadSchema.optional(),
  status: z.enum(["ready", "requires_input"]).optional(),
  missingInputs: z.array(z.string().trim().min(1).max(1_024)).max(MAX_COLLECTION_ENTRIES).optional(),
});
const analysisContentLinksSchema = z.array(z.strictObject({
  url: z.string().trim().min(1).max(4_096),
  fields: z.record(z.string().max(MAX_KEY_LENGTH), z.string().min(1).max(1_000)).optional(),
})).min(1).max(100);

export const analysisStartInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  objective: z.string().trim().min(1).max(MAX_SERIALIZED_INPUT_BYTES),
  channel: z.string().trim().min(1).max(1_024).optional(),
  inputMode: z.enum(["none", "links", "dataset", "api"]).optional(),
  referenceId: idSchema.optional(),
  links: analysisContentLinksSchema.optional(),
  url: z.string().trim().min(1).max(4_096).optional(),
  ownership: z.enum(["owned", "authorized"]).optional(),
  expiresAt: utcTimestampSchema.optional(),
  credentialRef: z.string().trim().min(1).max(1_024).optional(),
  ...commandContextInput,
});
export const marketingCapabilityListInputSchema = z.strictObject({});
export const analysisGraphGetInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
});
export const analysisGraphExpandInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  nodes: z.array(analysisNodeSchema).max(MAX_COLLECTION_ENTRIES),
  edges: z.array(analysisEdgeSchema).max(MAX_COLLECTION_ENTRIES),
  recommendedActions: z.array(analysisRecommendedActionSchema).max(MAX_COLLECTION_ENTRIES).optional(),
  ...commandContextInput,
});
export const analysisGraphForkInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  parentGraphId: idSchema,
  expectedVersion: positiveIntegerSchema,
  forkNodeId: analysisNodeReferenceSchema,
  ...commandContextInput,
});
export const metricComputeInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  batchId: idSchema,
  datasetId: idSchema,
  evidenceId: idSchema,
  assetId: idSchema,
  metricId: z.enum(["ctr_v1", "save_like_ratio_v1", "engagement_rate_v1", "conversion_rate_v1"]),
  comparability: analysisComparabilitySchema.optional(),
  ...commandContextInput,
});
const analyticsOperationInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("trend_v1"),
    datasetId: idSchema,
    parameters: z.strictObject({
      timeField: connectorIdentifierSchema,
      valueField: connectorIdentifierSchema,
      grain: z.enum(["day", "week"]),
    }),
  }),
  z.strictObject({
    operation: z.literal("funnel_v1"),
    datasetId: idSchema,
    parameters: z.strictObject({
      stageFields: z.array(connectorIdentifierSchema).min(2).max(500)
        .refine((fields) => new Set(fields).size === fields.length),
    }),
  }),
  z.strictObject({
    operation: z.literal("anomaly_v1"),
    datasetId: idSchema,
    parameters: z.strictObject({ valueField: connectorIdentifierSchema }),
  }),
]);
export const professionalAnalyticsComputeInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  batchId: idSchema,
  datasetId: idSchema,
  evidenceId: idSchema,
  assetId: idSchema,
  operation: analyticsOperationInputSchema,
  ...commandContextInput,
});
export const metricScenarioCreateInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  metricNodeId: analysisNodeReferenceSchema,
  targetValue: z.number().finite().nonnegative(),
  projectedDenominator: z.number().finite().nonnegative(),
  label: z.enum(["conservative", "base", "optimistic"]),
  ...commandContextInput,
});
export const metricMonitorCompareInputSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  expectedVersion: positiveIntegerSchema,
  baselineMetricNodeId: analysisNodeReferenceSchema,
  batchId: idSchema,
  datasetId: idSchema,
  evidenceId: idSchema,
  assetId: idSchema,
  scenarioNodeId: analysisNodeReferenceSchema.optional(),
  comparability: analysisComparabilitySchema.optional(),
  ...commandContextInput,
});

const rawStringSchema = z.string();
const rawNumberSchema = z.number();
const rawCommandContextInput = {
  actor: rawStringSchema,
  requestId: rawStringSchema,
  idempotencyKey: rawStringSchema,
};
const rawAnalysisNodeSchema = z.strictObject({
  id: rawStringSchema,
  kind: rawStringSchema,
  payload: z.unknown(),
});
const rawAnalysisEdgeSchema = z.strictObject({
  id: rawStringSchema,
  fromNodeId: rawStringSchema,
  toNodeId: rawStringSchema,
});
const rawAnalysisRecommendedActionSchema = z.strictObject({
  tool: rawStringSchema,
  description: rawStringSchema,
  arguments: z.unknown().optional(),
  status: rawStringSchema.optional(),
  missingInputs: z.array(rawStringSchema).optional(),
});
const rawAnalysisContentLinksSchema = z.array(z.strictObject({
  url: rawStringSchema,
  fields: z.unknown().optional(),
}));

export const analysisStartToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  objective: rawStringSchema,
  channel: rawStringSchema.optional(),
  inputMode: rawStringSchema.optional(),
  referenceId: rawStringSchema.optional(),
  links: rawAnalysisContentLinksSchema.optional(),
  url: rawStringSchema.optional(),
  ownership: rawStringSchema.optional(),
  expiresAt: rawStringSchema.optional(),
  credentialRef: rawStringSchema.optional(),
  ...rawCommandContextInput,
});
export const marketingCapabilityListToolSchema = z.strictObject({});
export const analysisGraphGetToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
});
export const analysisGraphExpandToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  nodes: z.array(rawAnalysisNodeSchema),
  edges: z.array(rawAnalysisEdgeSchema),
  recommendedActions: z.array(rawAnalysisRecommendedActionSchema).optional(),
  ...rawCommandContextInput,
});
export const analysisGraphForkToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  parentGraphId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  forkNodeId: rawStringSchema,
  ...rawCommandContextInput,
});
export const metricComputeToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  batchId: rawStringSchema,
  datasetId: rawStringSchema,
  evidenceId: rawStringSchema,
  assetId: rawStringSchema,
  metricId: rawStringSchema,
  comparability: rawStringSchema.optional(),
  ...rawCommandContextInput,
});
const rawAnalyticsOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("trend_v1"),
    datasetId: rawStringSchema,
    parameters: z.strictObject({
      timeField: rawStringSchema,
      valueField: rawStringSchema,
      grain: rawStringSchema,
    }),
  }),
  z.strictObject({
    operation: z.literal("funnel_v1"),
    datasetId: rawStringSchema,
    parameters: z.strictObject({ stageFields: z.array(rawStringSchema) }),
  }),
  z.strictObject({
    operation: z.literal("anomaly_v1"),
    datasetId: rawStringSchema,
    parameters: z.strictObject({ valueField: rawStringSchema }),
  }),
]);
export const professionalAnalyticsComputeToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  batchId: rawStringSchema,
  datasetId: rawStringSchema,
  evidenceId: rawStringSchema,
  assetId: rawStringSchema,
  operation: rawAnalyticsOperationSchema,
  ...rawCommandContextInput,
});
export const metricScenarioCreateToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  metricNodeId: rawStringSchema,
  targetValue: rawNumberSchema,
  projectedDenominator: rawNumberSchema,
  label: rawStringSchema,
  ...rawCommandContextInput,
});
export const metricMonitorCompareToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  baselineMetricNodeId: rawStringSchema,
  batchId: rawStringSchema,
  datasetId: rawStringSchema,
  evidenceId: rawStringSchema,
  assetId: rawStringSchema,
  scenarioNodeId: rawStringSchema.optional(),
  comparability: rawStringSchema.optional(),
  ...rawCommandContextInput,
});
const rawFreshnessSchema = z.strictObject({
  observedAt: rawStringSchema.optional(),
  evaluatedAt: rawStringSchema.optional(),
  maxAgeHours: rawNumberSchema.optional(),
});
const rawIngestLimitsSchema = z.strictObject({
  maxFileBytes: rawNumberSchema.optional(),
  maxFiles: rawNumberSchema.optional(),
  maxRows: rawNumberSchema.optional(),
  maxColumns: rawNumberSchema.optional(),
});
const rawParsedFileBatchSchema = z.strictObject({
  datasets: z.array(z.strictObject({
    source: z.strictObject({
      path: rawStringSchema,
      fileName: rawStringSchema,
      format: rawStringSchema,
      sizeBytes: rawNumberSchema,
      sheetName: rawStringSchema.optional(),
    }),
    fields: z.array(z.strictObject({
      name: rawStringSchema,
      index: rawNumberSchema,
      inferredType: rawStringSchema,
    })),
    rowsJsonl: rawStringSchema,
    quality: z.strictObject({
      rowCount: rawNumberSchema,
      columnCount: rawNumberSchema,
      duplicateRowCount: rawNumberSchema,
      emptyRowCount: rawNumberSchema,
      typeInconsistencyCount: rawNumberSchema,
    }),
    issues: z.array(z.strictObject({
      code: rawStringSchema,
      message: rawStringSchema,
      rowNumber: rawNumberSchema.optional(),
      columnNumber: rawNumberSchema.optional(),
    })),
  })),
});
const rawResearchLimitsSchema = z.strictObject({
  maxDepth: rawNumberSchema,
  maxPages: rawNumberSchema,
  maxDurationMs: rawNumberSchema,
  maxBytes: rawNumberSchema,
});

export const createWorkspaceToolSchema = z.strictObject({
  id: rawStringSchema,
  name: rawStringSchema,
  metadata: z.unknown().optional(),
  ...rawCommandContextInput,
});
export const registerSourceToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  name: rawStringSchema,
  type: rawStringSchema,
  ownership: rawStringSchema,
  metadata: z.unknown().optional(),
  ...rawCommandContextInput,
});
export const registerCapabilityToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  name: rawStringSchema,
  adapterKind: rawStringSchema,
  origin: rawStringSchema,
  configuration: z.unknown().optional(),
  ...rawCommandContextInput,
});
export const recordCapabilityHealthToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  healthy: z.boolean(),
  checkedAt: rawStringSchema,
  toolVersion: rawStringSchema.optional(),
  evidenceId: rawStringSchema.optional(),
  reason: rawStringSchema.optional(),
  ...rawCommandContextInput,
});
export const capabilityListToolSchema = z.strictObject({
  workspaceId: rawStringSchema,
  adapterKind: rawStringSchema.optional(),
  state: rawStringSchema.optional(),
});
export const registerDatasetToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  sourceId: rawStringSchema,
  name: rawStringSchema,
  coverageStart: rawStringSchema,
  coverageEnd: rawStringSchema,
  fieldDefinitions: z.unknown(),
  metricDefinitions: z.unknown(),
  limitations: z.unknown(),
  ...rawCommandContextInput,
});
export const recordEvidenceToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  sourceId: rawStringSchema,
  sourceLocator: rawStringSchema,
  observedAt: rawStringSchema,
  summary: rawStringSchema,
  contentHash: rawStringSchema,
  classification: rawStringSchema,
  toolHealth: z.strictObject({
    purpose: rawStringSchema,
    capabilityId: rawStringSchema,
    healthy: z.boolean(),
    checkedAt: rawStringSchema,
    toolVersion: rawStringSchema,
  }).optional(),
  ...rawCommandContextInput,
});
export const recordFindingToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  kind: rawStringSchema,
  statement: rawStringSchema,
  evidenceIds: z.array(rawStringSchema),
  limitations: rawStringSchema.optional(),
  unknownReason: rawStringSchema.optional(),
  ...rawCommandContextInput,
});
export const createRecommendationToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  findingIds: z.array(rawStringSchema),
  hypothesis: rawStringSchema,
  affectedStage: rawStringSchema,
  priority: rawStringSchema,
  expectedMetric: rawStringSchema,
  ...rawCommandContextInput,
});
export const createTaskToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  recommendationIds: z.array(rawStringSchema),
  assignee: rawStringSchema,
  dependencyIds: z.array(rawStringSchema),
  assetRequirements: z.array(rawStringSchema),
  acceptanceCriteria: z.array(rawStringSchema),
  ...rawCommandContextInput,
});
export const transitionTaskToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  next: rawStringSchema,
  expectedVersion: rawNumberSchema,
  ...rawCommandContextInput,
});
export const lineageGetToolSchema = z.strictObject({
  entityType: rawStringSchema,
  id: rawStringSchema,
  workspaceId: rawStringSchema,
});
export const dataRequestPlanToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  objective: rawStringSchema,
  questionTypes: z.array(rawStringSchema),
  availableFields: z.array(rawStringSchema),
  batch: rawParsedFileBatchSchema.optional(),
  freshness: rawFreshnessSchema.optional(),
  ...rawCommandContextInput,
});
export const dataRequestDeclineToolSchema = z.strictObject({
  planId: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedPlanVersion: rawNumberSchema,
  questionType: rawStringSchema,
  reason: rawStringSchema,
  ...rawCommandContextInput,
});
export const ingestFilesToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  paths: z.array(rawStringSchema),
  ownership: rawStringSchema.optional(),
  limits: rawIngestLimitsSchema.optional(),
  planId: rawStringSchema.optional(),
  expectedPlanVersion: rawNumberSchema.optional(),
  freshness: rawFreshnessSchema.optional(),
  ...rawCommandContextInput,
});
const rawStructuredTableQuerySchema = z.strictObject({
  databaseId: rawStringSchema,
  table: rawStringSchema,
  columns: z.array(rawStringSchema),
  filters: z.record(rawStringSchema, z.union([
    rawStringSchema,
    rawNumberSchema,
    z.boolean(),
    z.null(),
  ])),
  order: z.array(z.strictObject({ column: rawStringSchema, direction: rawStringSchema })),
  limit: rawNumberSchema,
});
export const connectorSqliteDiscoverToolSchema = z.strictObject({
  databaseId: rawStringSchema,
});
export const ingestSqliteToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  query: rawStructuredTableQuerySchema,
  ownership: rawStringSchema,
  planId: rawStringSchema.optional(),
  expectedPlanVersion: rawNumberSchema.optional(),
  freshness: rawFreshnessSchema.optional(),
  ...rawCommandContextInput,
});
export const ingestTemporaryApiToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  url: rawStringSchema,
  ownership: rawStringSchema,
  expiresAt: rawStringSchema,
  credentialRef: rawStringSchema.optional(),
  limits: rawIngestLimitsSchema.optional(),
  planId: rawStringSchema.optional(),
  expectedPlanVersion: rawNumberSchema.optional(),
  freshness: rawFreshnessSchema.optional(),
  ...rawCommandContextInput,
});
export const ingestContentLinksToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  links: z.array(z.strictObject({
    url: rawStringSchema,
    fields: z.record(z.string(), rawStringSchema).optional(),
  })),
  ...rawCommandContextInput,
});
export const researchSessionCreateToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  goal: rawStringSchema,
  seeds: z.array(rawStringSchema),
  expansion: z.boolean(),
  scope: rawResearchLimitsSchema.extend({
    hosts: z.array(rawStringSchema),
    pathPrefixes: z.array(rawStringSchema),
  }),
  ...rawCommandContextInput,
});
export const researchPermissionSetToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  expansion: rawStringSchema,
  ...rawCommandContextInput,
});
export const researchSessionRunToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  limits: rawResearchLimitsSchema.partial().optional(),
  ...rawCommandContextInput,
});
export const competitorConfirmToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  expectedVersion: rawNumberSchema,
  status: rawStringSchema,
  ...rawCommandContextInput,
});
export const competitorDiffCreateToolSchema = z.strictObject({
  id: rawStringSchema,
  workspaceId: rawStringSchema,
  competitorIds: z.tuple([rawStringSchema, rawStringSchema]),
  dimensions: z.array(rawStringSchema),
  ...rawCommandContextInput,
});
export const dataResearchGetToolSchema = z.strictObject({
  entityType: rawStringSchema,
  id: rawStringSchema,
  workspaceId: rawStringSchema,
});
export const evidenceAssetGetToolSchema = z.strictObject({
  workspaceId: rawStringSchema,
  evidenceId: rawStringSchema,
  assetId: rawStringSchema,
});

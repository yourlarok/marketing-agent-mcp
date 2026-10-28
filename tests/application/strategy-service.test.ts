import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/application/commands.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type {
  Clock,
  IdGenerator,
  Store,
} from "../../src/application/ports.js";
import type {
  GenerateRecommendation,
  RejectStrategyTask,
  ReorderStrategyTask,
  SupplementTask,
  UpdateStrategyTask,
} from "../../src/application/strategy-commands.js";
import { StrategyService } from "../../src/application/strategy-service.js";
import {
  createAnalysisGraph,
  createMetricScenario,
  type AnalysisGraph,
  type AnalysisGraphNode,
} from "../../src/domain/analysis-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import {
  computeMetric,
  getMetricDefinition,
  type MetricComputation,
} from "../../src/domain/metric-catalog.js";
import type { TaskState } from "../../src/domain/model.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-28T12:00:00.000Z";
const later = "2026-10-28T12:01:00.000Z";

class TestClock implements Clock {
  current = now;
  now(): string {
    return this.current;
  }
}

class TestIds implements IdGenerator {
  calls = 0;
  constructor(private readonly values: string[] = Array.from(
    { length: 1000 },
    (_, index) => `audit-${index + 1}`,
  )) {}

  next(): string {
    const value = this.values[this.calls];
    if (!value) throw new Error("No test ID available");
    this.calls += 1;
    return value;
  }
}

describe("StrategyService evidence-bound recommendations and user-controlled tasks", () => {
  let tempDir: string;
  let databasePath: string;
  let store: Store;
  let clock: TestClock;
  let ids: TestIds;
  let marketing: MarketingService;
  let service: StrategyService;
  let sequence: number;

  beforeEach(async () => {
    tempDir = await createTempDir();
    databasePath = join(tempDir, "strategy.db");
    store = openStore(databasePath);
    clock = new TestClock();
    ids = new TestIds();
    marketing = new MarketingService(store, clock, ids);
    service = new StrategyService(store, clock, ids);
    sequence = 0;

    await marketing.createWorkspace({
      input: { id: "workspace-1", name: "Northwind" },
      context: nextContext(),
    });
    await marketing.registerSource({
      input: {
        id: "source-owned",
        workspaceId: "workspace-1",
        name: "Owned warehouse",
        type: "database",
        ownership: "owned",
      },
      context: nextContext(),
    });
    for (const id of ["evidence-1", "evidence-2", "evidence-3"]) {
      await marketing.recordEvidence({
        input: {
          id,
          workspaceId: "workspace-1",
          sourceId: "source-owned",
          sourceLocator: `warehouse/${id}`,
          observedAt: now,
          summary: `Owned observation ${id}`,
          contentHash: id.slice(-1).repeat(64),
          classification: "owned_operating",
        },
        context: nextContext(),
      });
    }
    await marketing.recordFinding({
      input: {
        id: "finding-1",
        workspaceId: "workspace-1",
        kind: "fact",
        statement: "Observed click through rate is 0.1",
        evidenceIds: ["evidence-2", "evidence-1"],
      },
      context: nextContext(),
    });
    await insertGraph("graph-1", "workspace-1");
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(tempDir);
  });

  function nextContext(): CommandContext {
    sequence += 1;
    return {
      actor: "strategy-user",
      requestId: `strategy-request-${sequence}`,
      idempotencyKey: `strategy-command-${sequence}`,
    };
  }

  function baselineComputation(overrides: Partial<MetricComputation> = {}): MetricComputation {
    return {
      ...computeMetric("ctr_v1", [{ clicks: 100, impressions: 1000 }]),
      ...overrides,
    };
  }

  function graphNodes(
    baseline: MetricComputation = baselineComputation(),
    target = 0.15,
  ): AnalysisGraphNode[] {
    const scenario = createMetricScenario(baseline, {
      label: "base",
      targetValue: target,
      projectedDenominator: 1000,
    });
    return [
      {
        id: "supporting-node",
        kind: "research",
        payload: { evidenceIds: ["evidence-3", "evidence-2"] },
      },
      {
        id: "baseline-node",
        kind: "metric",
        payload: { ...baseline, evidenceId: "evidence-3" } as unknown as AnalysisGraphNode["payload"],
      },
      {
        id: "scenario-node",
        kind: "scenario",
        payload: { ...scenario, metricNodeId: "baseline-node" },
      },
    ];
  }

  async function insertGraph(
    id: string,
    workspaceId: string,
    nodes: AnalysisGraphNode[] = graphNodes(),
  ): Promise<AnalysisGraph> {
    const graph = createAnalysisGraph({
      id,
      workspaceId,
      createdAt: now,
      nodes,
    });
    await store.transaction((repos) => repos.analysisGraphs.insert(graph));
    return graph;
  }

  function recommendationInput(
    overrides: Partial<GenerateRecommendation> = {},
  ): GenerateRecommendation {
    return Object.fromEntries(Object.entries({
      id: "recommendation-1",
      workspaceId: "workspace-1",
      findingIds: ["finding-1"],
      hypothesis: "A clearer opening may increase qualified clicks",
      affectedStage: "click",
      targetChannels: ["xiaohongshu", "search"],
      priority: "p1",
      analysisGraphId: "graph-1",
      analysisNodeIds: ["supporting-node"],
      expectedMetrics: [{
        metricId: "ctr_v1",
        acceptance: "reach_scenario_target",
        baselineMetricNodeId: "baseline-node",
        scenarioNodeId: "scenario-node",
      }],
      ...overrides,
    }).filter(([, value]) => value !== undefined)) as unknown as GenerateRecommendation;
  }

  async function generateRecommendation(
    overrides: Partial<GenerateRecommendation> = {},
  ) {
    return service.generateRecommendation({
      input: recommendationInput(overrides),
      context: nextContext(),
    });
  }

  async function supplementTask(
    id = "task-1",
    overrides: Partial<SupplementTask> = {},
  ) {
    return service.supplementTask({
      input: {
        id,
        workspaceId: "workspace-1",
        recommendationIds: ["recommendation-1"],
        title: "Revise the opening",
        assignee: "content-owner",
        priority: "p1",
        rank: 1,
        dependencyIds: [],
        assetRequirements: ["existing approved opening"],
        acceptanceCriteria: ["A user reviews the revised opening"],
        ...overrides,
      },
      context: nextContext(),
    });
  }

  async function transition(id: string, next: TaskState, expectedVersion: number) {
    return marketing.transitionTask({
      input: { id, workspaceId: "workspace-1", next, expectedVersion },
      context: nextContext(),
    });
  }

  it("derives ordered evidence and copies exact Scenario arithmetic without accepting outcome claims", async () => {
    const recommendation = await generateRecommendation();

    expect(recommendation).toMatchObject({
      id: "recommendation-1",
      findingIds: ["finding-1"],
      evidenceIds: ["evidence-2", "evidence-1", "evidence-3"],
      targetChannels: ["xiaohongshu", "search"],
      affectedStage: "click",
      priority: "p1",
      expectedMetric: "ctr_v1",
      analysisNodeRefs: [
        { graphId: "graph-1", nodeId: "supporting-node" },
        { graphId: "graph-1", nodeId: "baseline-node" },
        { graphId: "graph-1", nodeId: "scenario-node" },
      ],
      impacts: [{
        formula: getMetricDefinition("ctr_v1").formula,
        baselineValue: 0.1,
        targetValue: 0.15,
        projectedDenominator: 1000,
        absoluteDelta: expect.closeTo(0.05, 12),
        relativeDelta: expect.closeTo(0.5, 12),
        projectedNumerator: 150,
        projectedNumeratorDelta: 50,
        assumptions: [
          "projected_denominator_fixed_for_projection",
          "other_conditions_unchanged",
        ],
        status: "ok",
        unknownReason: null,
        causality: "not_established",
      }],
    });
    expect(recommendation.impacts?.[0]?.absoluteDelta).toBeCloseTo(0.05, 12);
    expect(recommendation.impacts?.[0]?.relativeDelta).toBeCloseTo(0.5, 12);
    expect(recommendation).not.toHaveProperty("guaranteedOutcome");
    expect(recommendation).not.toHaveProperty("causedBy");
    const audit = await store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "recommendation", recommendation.id)
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "strategy.recommendation.generate",
      actor: "strategy-user",
      requestId: `strategy-request-${sequence}`,
    });
  });

  it("generates recommendations with migrated legacy graph and node IDs unchanged", async () => {
    const graphId = "9 legacy/graph:1";
    const supportingNodeId = "supporting node/1";
    const baselineMetricNodeId = "baseline node/1";
    const scenarioNodeId = "s".repeat(256);
    const ids = new Map([
      ["supporting-node", supportingNodeId],
      ["baseline-node", baselineMetricNodeId],
      ["scenario-node", scenarioNodeId],
    ]);
    const nodes = graphNodes().map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      payload: node.id === "scenario-node"
        ? { ...node.payload, metricNodeId: baselineMetricNodeId }
        : node.payload,
    }));
    await insertGraph(graphId, "workspace-1", nodes);

    const recommendation = await generateRecommendation({
      analysisGraphId: graphId,
      analysisNodeIds: [supportingNodeId],
      expectedMetrics: [{
        metricId: "ctr_v1",
        acceptance: "reach_scenario_target",
        baselineMetricNodeId,
        scenarioNodeId,
      }],
    });
    expect(recommendation.analysisNodeRefs).toEqual([
      { graphId, nodeId: supportingNodeId },
      { graphId, nodeId: baselineMetricNodeId },
      { graphId, nodeId: scenarioNodeId },
    ]);
  });

  it("derives independent Analytics evidence only from allowed provenance and current references", async () => {
    for (const id of ["evidence-4", "evidence-5"]) {
      await marketing.recordEvidence({
        input: {
          id, workspaceId: "workspace-1", sourceId: "source-owned", sourceLocator: `warehouse/${id}`,
          observedAt: now, summary: `Analytics observation ${id}`, contentHash: id.slice(-1).repeat(64),
          classification: "owned_operating",
        },
        context: nextContext(),
      });
    }
    await insertGraph("graph-analytics", "workspace-1", [{
      id: "analytics-node",
      kind: "analytics",
      payload: {
        operation: "trend_v1",
        provenance: { evidenceId: "evidence-4" },
        current: { evidenceId: "evidence-5" },
        untrusted: { evidenceId: "evidence-missing" },
      },
    }]);

    const recommendation = await generateRecommendation({
      analysisGraphId: "graph-analytics",
      analysisNodeIds: ["analytics-node"],
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    expect(recommendation.evidenceIds).toEqual(["evidence-2", "evidence-1", "evidence-4", "evidence-5"]);
    expect(recommendation.analysisNodeRefs).toEqual([{ graphId: "graph-analytics", nodeId: "analytics-node" }]);
  });

  it("rejects public Analytics provenance evidence for owned conversion recommendations", async () => {
    await marketing.registerSource({
      input: {
        id: "source-analytics-public", workspaceId: "workspace-1", name: "Public analytics",
        type: "link", ownership: "external_public",
      },
      context: nextContext(),
    });
    await marketing.recordEvidence({
      input: {
        id: "evidence-analytics-public", workspaceId: "workspace-1", sourceId: "source-analytics-public",
        sourceLocator: "https://example.test/public-analytics", observedAt: now,
        summary: "Public analytics interactions", contentHash: "f".repeat(64), classification: "external_observation",
      },
      context: nextContext(),
    });
    await insertGraph("graph-public-analytics", "workspace-1", [{
      id: "analytics-public",
      kind: "analytics",
      payload: { operation: "trend_v1", provenance: { evidenceId: "evidence-analytics-public" } },
    }]);

    await expect(generateRecommendation({
      analysisGraphId: "graph-public-analytics",
      analysisNodeIds: ["analytics-public"],
      affectedStage: "purchase",
      expectedMetrics: [{ metricId: "conversion_rate_v1", acceptance: "establish_baseline" }],
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("uses the catalog formula and explicit unknown expected space for establish_baseline", async () => {
    const recommendation = await generateRecommendation({
      analysisGraphId: undefined,
      analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });

    expect(recommendation.analysisNodeRefs).toBeUndefined();
    expect(recommendation.impacts).toEqual([{
      formula: getMetricDefinition("ctr_v1").formula,
      baselineValue: null,
      targetValue: null,
      projectedDenominator: null,
      absoluteDelta: null,
      relativeDelta: null,
      projectedNumerator: null,
      projectedNumeratorDelta: null,
      assumptions: [],
      status: "unknown",
      unknownReason: "BASELINE_NOT_COMPUTED",
      causality: "not_established",
    }]);
  });

  it("preserves unknown Scenario values instead of manufacturing a baseline", async () => {
    const unknown = baselineComputation({ value: null, numerator: 10, denominator: 0, status: "unknown", unknownReason: "ZERO_DENOMINATOR" });
    await insertGraph("graph-unknown", "workspace-1", graphNodes(unknown));

    const recommendation = await generateRecommendation({
      id: "recommendation-unknown",
      analysisGraphId: "graph-unknown",
    });
    expect(recommendation.impacts?.[0]).toMatchObject({
      baselineValue: null,
      targetValue: 0.15,
      projectedDenominator: 1000,
      absoluteDelta: null,
      relativeDelta: null,
      projectedNumerator: null,
      projectedNumeratorDelta: null,
      status: "unknown",
      unknownReason: "UNKNOWN_BASELINE",
      causality: "not_established",
    });
  });

  it.each([
    ["baseline value", "baseline-node", { value: 0.1 }],
    ["scenario absolute delta", "scenario-node", { absoluteDelta: 0.05 }],
    ["scenario projected numerator", "scenario-node", { projectedNumerator: 150 }],
  ])("rejects pseudo-precise unknown Scenario %s", async (_label, nodeId, payloadPatch) => {
    const unknown = baselineComputation({
      status: "unknown",
      unknownReason: "ZERO_DENOMINATOR",
      ...(nodeId === "baseline-node" ? {} : { value: null, numerator: 10, denominator: 0 }),
    });
    const nodes = graphNodes(unknown).map((node) => node.id === nodeId
      ? { ...node, payload: { ...node.payload, ...payloadPatch } }
      : node);
    await insertGraph(`graph-pseudo-${_label.replaceAll(" ", "-")}`, "workspace-1", nodes);

    await expect(generateRecommendation({
      analysisGraphId: `graph-pseudo-${_label.replaceAll(" ", "-")}`,
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it.each([
    ["missing finding", { findingIds: ["finding-missing"] }, "NOT_FOUND"],
    ["missing graph", { analysisGraphId: "graph-missing" }, "NOT_FOUND"],
    ["missing supporting node", { analysisNodeIds: ["node-missing"] }, "NOT_FOUND"],
    ["missing baseline node", { expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", baselineMetricNodeId: "node-missing", scenarioNodeId: "scenario-node" }] }, "NOT_FOUND"],
    ["missing scenario node", { expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", baselineMetricNodeId: "baseline-node", scenarioNodeId: "node-missing" }] }, "NOT_FOUND"],
  ] as const)("rejects a %s without persistence", async (_label, overrides, code) => {
    const input = recommendationInput(overrides as Partial<GenerateRecommendation>);
    const context = nextContext();
    await expect(service.generateRecommendation({ input, context }))
      .rejects.toMatchObject<DomainError>({ code });
    expect(await store.transaction((repos) => repos.recommendations.get(input.id, input.workspaceId)))
      .toBeUndefined();
    expect(await store.transaction((repos) => repos.idempotency.get(input.workspaceId, context.idempotencyKey)))
      .toBeUndefined();
  });

  it("does not resolve Findings, graphs, nodes, or evidence across workspaces", async () => {
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-2", workspaceId: "workspace-2", version: 1,
        createdAt: now, updatedAt: now, name: "Contoso",
      });
      await repos.sources.insert({
        id: "source-other", workspaceId: "workspace-2", version: 1,
        createdAt: now, updatedAt: now, name: "Other source", type: "manual", ownership: "owned",
      });
      await repos.evidence.insert({
        id: "evidence-other", workspaceId: "workspace-2", version: 1,
        createdAt: now, updatedAt: now, sourceId: "source-other", sourceLocator: "other",
        observedAt: now, summary: "Other evidence", contentHash: "f".repeat(64), classification: "owned_operating",
      });
      await repos.findings.insert({
        id: "finding-other", workspaceId: "workspace-2", version: 1,
        createdAt: now, updatedAt: now, kind: "fact", statement: "Other finding", evidenceIds: ["evidence-other"],
      });
    });
    const otherNodes = graphNodes().map((node) => {
      const { evidenceId: _evidenceId, evidenceIds: _evidenceIds, ...payload } = node.payload;
      return { ...node, payload: { ...payload, evidenceId: "evidence-other" } };
    });
    await insertGraph("graph-other", "workspace-2", otherNodes);

    await expect(generateRecommendation({ findingIds: ["finding-other"] }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(generateRecommendation({ analysisGraphId: "graph-other" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const brokenStore: Store = {
      transaction: (work) => store.transaction(async (repos) => {
        const graph = (await repos.analysisGraphs.get("graph-1", "workspace-1"))!;
        graph.nodes[0]!.payload.evidenceIds = ["evidence-other"];
        return work({
          ...repos,
          analysisGraphs: { ...repos.analysisGraphs, get: async () => graph },
        });
      }),
      close: () => undefined,
    };
    service = new StrategyService(brokenStore, clock, ids);
    await expect(generateRecommendation({ id: "recommendation-bad-evidence" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it.each([
    ["baseline kind", "baseline-node", { kind: "question" }],
    ["scenario kind", "scenario-node", { kind: "question" }],
    ["scenario baseline reference", "scenario-node", { payload: { metricNodeId: "another-node" } }],
    ["scenario baseline value", "scenario-node", { payload: { baselineValue: 0.9 } }],
    ["scenario baseline numerator", "scenario-node", { payload: { baselineNumerator: 900 } }],
    ["scenario baseline denominator", "scenario-node", { payload: { baselineDenominator: 900 } }],
    ["baseline known/unknown status", "baseline-node", { payload: { status: "unknown", unknownReason: "ZERO_DENOMINATOR" } }],
    ["scenario known/unknown status", "scenario-node", { payload: { status: "unknown", relativeDeltaUnknownReason: "UNKNOWN_BASELINE" } }],
    ["scenario metric", "scenario-node", { payload: { metricId: "engagement_rate_v1" } }],
    ["baseline metric", "baseline-node", { payload: { metricId: "engagement_rate_v1" } }],
    ["scenario definition", "scenario-node", { payload: { definitionVersion: 2 } }],
    ["baseline definition", "baseline-node", { payload: { definitionVersion: 2 } }],
  ])("rejects Scenario/Metric mismatch: %s", async (_label, nodeId, patch) => {
    const nodes = graphNodes().map((node) => node.id === nodeId
      ? { ...node, ...patch, payload: { ...node.payload, ...("payload" in patch ? patch.payload : {}) } }
      : node);
    await insertGraph(`graph-mismatch-${_label.replaceAll(" ", "-")}`, "workspace-1", nodes);

    await expect(generateRecommendation({
      analysisGraphId: `graph-mismatch-${_label.replaceAll(" ", "-")}`,
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it.each([
    ["empty channels", { targetChannels: [] }],
    ["duplicate channels", { targetChannels: ["search", "search"] }],
    ["unsupported stage", { affectedStage: "conversion" }],
    ["legacy priority", { priority: "high" }],
    ["missing metrics", { expectedMetrics: undefined }],
    ["null metric", { expectedMetrics: [null] }],
    ["duplicate metrics", { expectedMetrics: [
      { metricId: "ctr_v1", acceptance: "establish_baseline" },
      { metricId: "ctr_v1", acceptance: "establish_baseline" },
    ] }],
    ["reach without baseline", { expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", scenarioNodeId: "scenario-node" }] }],
    ["baseline with nodes", { expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline", baselineMetricNodeId: "baseline-node" }] }],
    ["nodes without graph", { analysisGraphId: undefined }],
  ])("rejects invalid strategy targeting: %s", async (_label, overrides) => {
    await expect(generateRecommendation(overrides as Partial<GenerateRecommendation>))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it.each([
    ["evidenceIds", ["evidence-1"]],
    ["formula", "clicks / impressions"],
    ["baselineValue", 0.9],
    ["targetValue", 0.9],
    ["projectedDenominator", 500],
    ["projectedNumerator", 450],
    ["absoluteDelta", 0.8],
    ["relativeDelta", 8],
    ["projectedNumeratorDelta", 400],
    ["causality", "established"],
  ])("does not accept caller-controlled expected-space field %s", async (field, value) => {
    await expect(service.generateRecommendation({
      input: { ...recommendationInput(), [field]: value } as GenerateRecommendation,
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("does not substitute public interactions for owned conversion performance", async () => {
    await marketing.registerSource({
      input: {
        id: "source-public", workspaceId: "workspace-1", name: "Public observations",
        type: "link", ownership: "external_public",
      },
      context: nextContext(),
    });
    await marketing.recordEvidence({
      input: {
        id: "evidence-public", workspaceId: "workspace-1", sourceId: "source-public",
        sourceLocator: "https://example.test/interactions", observedAt: now,
        summary: "Public likes and saves", contentHash: "e".repeat(64), classification: "external_observation",
      },
      context: nextContext(),
    });
    await marketing.recordFinding({
      input: {
        id: "finding-public", workspaceId: "workspace-1", kind: "fact",
        statement: "Public interactions increased", evidenceIds: ["evidence-public"],
      },
      context: nextContext(),
    });

    await expect(generateRecommendation({
      findingIds: ["finding-public"],
      analysisGraphId: undefined,
      analysisNodeIds: undefined,
      affectedStage: "purchase",
      expectedMetrics: [{ metricId: "conversion_rate_v1", acceptance: "establish_baseline" }],
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("supplements a draft Task without creating production capabilities or approval/publication actions", async () => {
    await generateRecommendation({
      analysisGraphId: undefined,
      analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });

    const task = await supplementTask();
    expect(task).toMatchObject({
      id: "task-1", state: "draft", version: 1, title: "Revise the opening",
      priority: "p1", rank: 1, assignee: "content-owner",
    });
    const audits = await store.transaction((repos) => repos.audit.listForEntity("workspace-1", "task", task.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "strategy.task.supplement", actor: "strategy-user" });
    expect(audits.map((audit) => audit.action)).toEqual(["strategy.task.supplement"]);
    expect(await store.transaction((repos) => repos.capabilities.list("workspace-1"))).toEqual([]);
    await expect(service.getStrategyTask({ id: task.id, workspaceId: task.workspaceId })).resolves.toEqual(task);
  });

  it("updates every mutable field and revalidates references", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    await generateRecommendation({
      id: "recommendation-2", analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "engagement_rate_v1", acceptance: "establish_baseline" }],
    });
    await supplementTask("dependency-1", { rank: 2 });
    await supplementTask();

    const updated = await service.updateStrategyTask({
      input: {
        id: "task-1", workspaceId: "workspace-1", expectedVersion: 1,
        recommendationIds: ["recommendation-2"], title: "New title", assignee: "new-owner",
        priority: "p0", dependencyIds: ["dependency-1"], assetRequirements: [],
        acceptanceCriteria: ["New acceptance criterion"],
      },
      context: nextContext(),
    });
    expect(updated).toMatchObject({
      version: 2, recommendationIds: ["recommendation-2"], title: "New title",
      assignee: "new-owner", priority: "p0", dependencyIds: ["dependency-1"],
      assetRequirements: [], acceptanceCriteria: ["New acceptance criterion"],
    });
    await expect(service.updateStrategyTask({
      input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 2 },
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.updateStrategyTask({
      input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 2, recommendationIds: ["recommendation-missing"] },
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it.each([
    ["draft", 1],
    ["ready", 2],
    ["in_progress", 3],
    ["blocked", 4],
  ] as const)("rejects a %s task with an audited reason", async (targetState, version) => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    await supplementTask();
    if (targetState !== "draft") await transition("task-1", "ready", 1);
    if (["in_progress", "blocked"].includes(targetState)) await transition("task-1", "in_progress", 2);
    if (targetState === "blocked") await transition("task-1", "blocked", 3);

    const rejected = await service.rejectStrategyTask({
      input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: version, reason: "Not actionable" },
      context: nextContext(),
    });
    expect(rejected).toMatchObject({ state: "rejected", rejectionReason: "Not actionable", version: version + 1 });
  });

  it("enforces terminal immutability and stale expectedVersion for update, reject, and reorder", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    await supplementTask();
    await transition("task-1", "ready", 1);
    await transition("task-1", "in_progress", 2);
    await transition("task-1", "completed", 3);

    for (const invoke of [
      () => service.updateStrategyTask({ input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 4, title: "Changed" }, context: nextContext() }),
      () => service.rejectStrategyTask({ input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 4, reason: "Again" }, context: nextContext() }),
      () => service.reorderStrategyTask({ input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 4, rank: 9 }, context: nextContext() }),
    ]) {
      await expect(invoke()).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    }

    await supplementTask("task-2", { rank: 2 });
    await service.rejectStrategyTask({
      input: { id: "task-2", workspaceId: "workspace-1", expectedVersion: 1, reason: "Stop" },
      context: nextContext(),
    });
    await expect(service.rejectStrategyTask({
      input: { id: "task-2", workspaceId: "workspace-1", expectedVersion: 2, reason: "Again" },
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    await supplementTask("task-3", { rank: 3 });
    await service.updateStrategyTask({
      input: { id: "task-3", workspaceId: "workspace-1", expectedVersion: 1, title: "Current title" },
      context: nextContext(),
    });
    for (const invoke of [
      () => service.updateStrategyTask({ input: { id: "task-3", workspaceId: "workspace-1", expectedVersion: 1, title: "Stale" }, context: nextContext() }),
      () => service.rejectStrategyTask({ input: { id: "task-3", workspaceId: "workspace-1", expectedVersion: 1, reason: "Stale" }, context: nextContext() }),
      () => service.reorderStrategyTask({ input: { id: "task-3", workspaceId: "workspace-1", expectedVersion: 1, rank: 4 }, context: nextContext() }),
    ]) {
      await expect(invoke()).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    }
    expect(await service.getStrategyTask({ id: "task-3", workspaceId: "workspace-1" })).toMatchObject({ version: 2, rank: 3, state: "draft" });
  });

  it("supports supplemental dependencies, rejects self/multi-node cycles, and rejected dependencies never satisfy readiness", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    await supplementTask("task-a", { rank: 1 });
    await supplementTask("task-b", { rank: 2, dependencyIds: ["task-a"] });
    await supplementTask("task-c", { rank: 3, dependencyIds: ["task-b"] });

    await expect(service.updateStrategyTask({
      input: { id: "task-a", workspaceId: "workspace-1", expectedVersion: 1, dependencyIds: ["task-a"] },
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.updateStrategyTask({
      input: { id: "task-a", workspaceId: "workspace-1", expectedVersion: 1, dependencyIds: ["task-c"] },
      context: nextContext(),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expect(transition("task-c", "ready", 1)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await service.rejectStrategyTask({
      input: { id: "task-b", workspaceId: "workspace-1", expectedVersion: 1, reason: "No longer useful" },
      context: nextContext(),
    });
    await expect(transition("task-c", "ready", 1)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it("sorts numeric ranks then legacy null ranks with deterministic cursor pagination and reorder", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    await supplementTask("task-b", { rank: 2 });
    await supplementTask("task-c", { rank: 1 });
    await supplementTask("task-a", { rank: 2 });
    for (const id of ["legacy-b", "legacy-a"]) {
      await marketing.createTask({
        input: {
          id, workspaceId: "workspace-1", recommendationIds: ["recommendation-1"], assignee: "legacy-owner",
          dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["Legacy criterion"],
        },
        context: nextContext(),
      });
    }

    const first = await service.listStrategyTasks({ workspaceId: "workspace-1", limit: 2 });
    expect(first.tasks.map((task) => task.id)).toEqual(["task-c", "task-a"]);
    expect(first.nextCursor).toEqual({ rank: 2, id: "task-a" });
    expect(first.tasks[0]).toEqual({
      id: "task-c", version: 1, title: "Revise the opening", assignee: "content-owner",
      priority: "p1", rank: 1, state: "draft", updatedAt: now,
    });
    const second = await service.listStrategyTasks({ workspaceId: "workspace-1", limit: 2, cursor: first.nextCursor! });
    expect(second.tasks.map((task) => task.id)).toEqual(["task-b", "legacy-a"]);
    expect(second.nextCursor).toEqual({ rank: null, id: "legacy-a" });
    const third = await service.listStrategyTasks({ workspaceId: "workspace-1", limit: 2, cursor: second.nextCursor! });
    expect(third.tasks.map((task) => task.id)).toEqual(["legacy-b"]);
    expect(third.tasks[0]).toMatchObject({ title: null, priority: null, rank: null });
    expect(third.nextCursor).toBeNull();

    clock.current = later;
    const reordered = await service.reorderStrategyTask({
      input: { id: "task-c", workspaceId: "workspace-1", expectedVersion: 1, rank: 3 },
      context: nextContext(),
    });
    expect(reordered).toMatchObject({ rank: 3, version: 2, updatedAt: later });
    expect((await service.listStrategyTasks({ workspaceId: "workspace-1" })).tasks.map((task) => task.id))
      .toEqual(["task-a", "task-b", "task-c", "legacy-a", "legacy-b"]);
    await expect(service.listStrategyTasks({ workspaceId: "workspace-1", limit: 21 }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it.each(["generate", "supplement", "update", "reject", "reorder"] as const)(
    "exactly replays and detects conflicts for %s with action/actor/request audit",
    async (kind) => {
      if (kind !== "generate") {
        await generateRecommendation({
          analysisGraphId: undefined, analysisNodeIds: undefined,
          expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
        });
        await supplementTask();
      }
      const input: Record<string, unknown> = kind === "generate" ? recommendationInput({
        analysisGraphId: undefined, analysisNodeIds: undefined,
        expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
      }) : kind === "supplement" ? {
        id: "task-supplement", workspaceId: "workspace-1", recommendationIds: ["recommendation-1"],
        title: "Supplement", assignee: "owner", priority: "p2", rank: 2, dependencyIds: [],
        assetRequirements: [], acceptanceCriteria: ["User acceptance"],
      } : kind === "update" ? {
        id: "task-1", workspaceId: "workspace-1", expectedVersion: 1, title: "Updated",
      } : kind === "reject" ? {
        id: "task-1", workspaceId: "workspace-1", expectedVersion: 1, reason: "Reject",
      } : {
        id: "task-1", workspaceId: "workspace-1", expectedVersion: 1, rank: 8,
      };
      const context = nextContext();
      const run = (value: Record<string, unknown>): Promise<unknown> => {
        if (kind === "generate") return service.generateRecommendation({ input: value as GenerateRecommendation, context });
        if (kind === "supplement") return service.supplementTask({ input: value as unknown as SupplementTask, context });
        if (kind === "update") return service.updateStrategyTask({ input: value as UpdateStrategyTask, context });
        if (kind === "reject") return service.rejectStrategyTask({ input: value as RejectStrategyTask, context });
        return service.reorderStrategyTask({ input: value as ReorderStrategyTask, context });
      };
      const first = await run(input);
      const auditCount = await store.transaction(async (repos) => (await repos.audit.listForEntity(
        "workspace-1", kind === "generate" ? "recommendation" : "task", String(input.id),
      )).length);
      await expect(run(input)).resolves.toEqual(first);
      const changed = kind === "reject" ? { reason: "Different" }
        : kind === "reorder" ? { rank: 9 }
        : kind === "generate" ? { hypothesis: "Different hypothesis" }
        : { title: "Different" };
      await expect(run({ ...input, ...changed })).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
      const audits = await store.transaction((repos) => repos.audit.listForEntity(
        "workspace-1", kind === "generate" ? "recommendation" : "task", String(input.id),
      ));
      expect(audits).toHaveLength(auditCount);
      expect(audits.at(-1)).toMatchObject({
        action: {
          generate: "strategy.recommendation.generate",
          supplement: "strategy.task.supplement",
          update: "strategy.task.update",
          reject: "strategy.task.reject",
          reorder: "strategy.task.reorder",
        }[kind],
        actor: context.actor,
        requestId: context.requestId,
      });
    },
  );

  it("rolls back a Task mutation and idempotency record when audit append fails", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    const original = await supplementTask();
    service = new StrategyService(store, clock, new TestIds(["audit-1"]));
    const context = nextContext();

    await expect(service.updateStrategyTask({
      input: { id: "task-1", workspaceId: "workspace-1", expectedVersion: 1, title: "Rolled back" },
      context,
    })).rejects.toThrow();
    expect(await service.getStrategyTask({ id: "task-1", workspaceId: "workspace-1" })).toEqual(original);
    expect(await store.transaction((repos) => repos.idempotency.get("workspace-1", context.idempotencyKey)))
      .toBeUndefined();
  });

  it("recovers full Task reads and command replay after restart", async () => {
    await generateRecommendation({
      analysisGraphId: undefined, analysisNodeIds: undefined,
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    });
    const command = {
      input: {
        id: "task-restart", workspaceId: "workspace-1", recommendationIds: ["recommendation-1"],
        title: "Persistent task", assignee: "owner", priority: "p0" as const, rank: 4,
        dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["Persistent criterion"],
      },
      context: nextContext(),
    };
    const created = await service.supplementTask(command);
    store.close();
    store = openStore(databasePath);
    service = new StrategyService(store, clock, ids);

    await expect(service.getStrategyTask({ id: created.id, workspaceId: created.workspaceId })).resolves.toEqual(created);
    await expect(service.supplementTask(command)).resolves.toEqual(created);
    expect((await service.listStrategyTasks({ workspaceId: "workspace-1" })).tasks).toEqual([
      expect.objectContaining({ id: created.id, title: "Persistent task", rank: 4 }),
    ]);
  });
});

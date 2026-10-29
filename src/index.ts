import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnalysisService } from "./application/analysis-service.js";
import { BenchmarkService } from "./application/benchmark-service.js";
import { ContentProductionService } from "./application/content-production-service.js";
import { DashboardService } from "./application/dashboard-service.js";
import { DataResearchService } from "./application/data-research-service.js";
import { MarketingService } from "./application/marketing-service.js";
import { PublicationScheduler } from "./application/publication-scheduler.js";
import { PublishingService } from "./application/publishing-service.js";
import { StrategyService } from "./application/strategy-service.js";
import { loadConfig } from "./config.js";
import { ArtifactStore } from "./infrastructure/artifact-store.js";
import { McpAnalyticsProvider } from "./infrastructure/analytics-provider.js";
import { McpBenchmarkReverseProvider } from "./infrastructure/benchmark-reverse-provider.js";
import { McpMediaProvider } from "./infrastructure/media-provider.js";
import { MediaValidator } from "./infrastructure/media-validation.js";
import { McpPublishingProvider } from "./infrastructure/publishing-provider.js";
import { SqliteConnector } from "./infrastructure/sqlite-connector.js";
import { openStore } from "./infrastructure/sqlite-store.js";
import {
  SystemClock,
  SystemIdGenerator,
} from "./infrastructure/system.js";
import { createMcpServer } from "./mcp/server.js";

async function run(): Promise<void> {
  const config = loadConfig(process.env);
  const store = openStore(join(config.dataDir, "marketing.db"));
  let scheduler: PublicationScheduler | undefined;
  try {
    const clock = new SystemClock();
    const ids = new SystemIdGenerator();
    const service = new MarketingService(store, clock, ids);
    const artifacts = new ArtifactStore(config.artifactDir);
    const dataResearch = new DataResearchService(
      store,
      clock,
      ids,
      artifacts,
      undefined,
      undefined,
      new SqliteConnector(config.databaseRoot, clock),
    );
    const analysis = new AnalysisService(
      store,
      clock,
      ids,
      artifacts,
      config.analyticsMcp ? new McpAnalyticsProvider({
        command: config.analyticsMcp.command,
        args: config.analyticsMcp.args,
      }) : undefined,
    );
    const dashboard = new DashboardService(store, clock, ids, artifacts);
    const strategy = new StrategyService(store, clock, ids);
    const benchmark = new BenchmarkService(
      store,
      clock,
      ids,
      artifacts,
      config.benchmarkMcp ? new McpBenchmarkReverseProvider({
        command: config.benchmarkMcp.command,
        args: config.benchmarkMcp.args,
      }) : undefined,
    );
    const contentProduction = new ContentProductionService(
      store,
      clock,
      ids,
      artifacts,
      config.mediaMcp ? new McpMediaProvider({
        command: config.mediaMcp.command,
        args: config.mediaMcp.args,
        envAllowlist: config.mediaMcp.envAllowlist,
      }) : undefined,
      new MediaValidator({
        ...(config.ffprobeCommand ? { ffprobeCommand: config.ffprobeCommand } : {}),
      }),
    );
    const publishingProvider = new McpPublishingProvider({
      ...(config.publishingMcp ? {
        command: config.publishingMcp.command,
        args: config.publishingMcp.args,
        envAllowlist: config.publishingMcp.envAllowlist,
      } : {}),
    });
    const publishing = new PublishingService(
      store,
      clock,
      ids,
      artifacts,
      publishingProvider,
      publishingProvider,
    );
    scheduler = new PublicationScheduler(store, publishing, clock, {
      onError: (error) => console.error(
        `Publication scheduler failed: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
    });
    const server = createMcpServer(
      service,
      dataResearch,
      analysis,
      {},
      dashboard,
      strategy,
      benchmark,
      contentProduction,
    );
    await scheduler.start();
    const transport = new StdioServerTransport();
    let shutdown: Promise<void> | undefined;

    const close = (): Promise<void> => {
      shutdown ??= (async () => {
        try {
          await scheduler?.stop();
        } finally {
          try {
            await server.close();
          } finally {
            store.close();
          }
        }
      })();
      return shutdown;
    };
    const reportCloseFailure = (error: unknown): void => {
      console.error(
        `MCP shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exitCode = 1;
    };
    transport.onclose = () => {
      void close().catch(reportCloseFailure);
    };
    process.once("SIGINT", () => {
      void close().catch(reportCloseFailure);
    });
    process.once("SIGTERM", () => {
      void close().catch(reportCloseFailure);
    });

    await server.connect(transport);
  } catch (error) {
    try {
      await scheduler?.stop();
    } finally {
      store.close();
    }
    throw error;
  }
}

run().catch((error: unknown) => {
  console.error(
    `MCP startup failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});

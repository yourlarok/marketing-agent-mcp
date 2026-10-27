import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnalysisService } from "./application/analysis-service.js";
import { DataResearchService } from "./application/data-research-service.js";
import { MarketingService } from "./application/marketing-service.js";
import { loadConfig } from "./config.js";
import { ArtifactStore } from "./infrastructure/artifact-store.js";
import { openStore } from "./infrastructure/sqlite-store.js";
import {
  SystemClock,
  SystemIdGenerator,
} from "./infrastructure/system.js";
import { createMcpServer } from "./mcp/server.js";

async function run(): Promise<void> {
  const config = loadConfig(process.env);
  const store = openStore(join(config.dataDir, "marketing.db"));
  try {
    const clock = new SystemClock();
    const ids = new SystemIdGenerator();
    const service = new MarketingService(store, clock, ids);
    const artifacts = new ArtifactStore(config.artifactDir);
    const dataResearch = new DataResearchService(store, clock, ids, artifacts);
    const analysis = new AnalysisService(store, clock, ids, artifacts);
    const server = createMcpServer(service, dataResearch, analysis);
    const transport = new StdioServerTransport();
    let shutdown: Promise<void> | undefined;

    const close = (): Promise<void> => {
      shutdown ??= (async () => {
        try {
          await server.close();
        } finally {
          store.close();
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
      try {
        store.close();
      } catch (error) {
        reportCloseFailure(error);
      }
    };
    process.once("SIGINT", () => {
      void close().catch(reportCloseFailure);
    });
    process.once("SIGTERM", () => {
      void close().catch(reportCloseFailure);
    });

    await server.connect(transport);
  } catch (error) {
    store.close();
    throw error;
  }
}

run().catch((error: unknown) => {
  console.error(
    `MCP startup failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});

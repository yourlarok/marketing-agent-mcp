import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MarketingService } from "./application/marketing-service.js";
import { loadConfig } from "./config.js";
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
    const service = new MarketingService(
      store,
      new SystemClock(),
      new SystemIdGenerator(),
    );
    const server = createMcpServer(service);
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

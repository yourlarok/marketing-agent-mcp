import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("data analytics smoke and documentation contracts", () => {
  it("includes the real public data analytics stdio suite in npm smoke", async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: { smoke: string };
    };
    expect(manifest.scripts.smoke).toContain("tests/e2e/public-data-analytics-stdio.test.ts");
  });

  it("documents SQLite, metric, Wilson, external MCP, and unsupported boundaries", async () => {
    const readme = await readFile(join(projectRoot, "README.md"), "utf8");
    for (const required of [
      "MARKETING_DATABASE_ROOT",
      "只读",
      "任意 SQL",
      "显式快照",
      "实时同步",
      "(sum(likes) + sum(saves) + sum(comments)) / sum(impressions)",
      "sum(conversions) / sum(clicks)",
      "external_public",
      "Wilson",
      "95%",
      "IID",
      "Bernoulli",
      "非因果",
      "不适用",
      "MARKETING_ANALYTICS_MCP_COMMAND",
      "MARKETING_ANALYTICS_MCP_ARGS",
      "inputHash",
      "复算",
      "100,000",
      "16 MiB",
      "15 秒",
      "OS 沙箱",
      "PostgreSQL",
      "MySQL",
      "GA4",
      "OAuth",
      "视图",
      "BLOB",
      "/dev/fd",
      "POSIX",
      "connector_sqlite_discover",
      "ingest_sqlite",
      "professional_analytics_compute",
      "不提供仪表盘、内容生成",
    ]) {
      expect(readme, `README must disclose ${required}`).toContain(required);
    }
  });
});

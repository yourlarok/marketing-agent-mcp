import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("data analytics smoke and documentation contracts", () => {
  it("retains every stdio suite and includes dashboard strategy in npm smoke", async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: { smoke: string };
    };
    for (const suite of [
      "tests/e2e/stdio.test.ts",
      "tests/e2e/data-research-stdio.test.ts",
      "tests/e2e/analysis-stdio.test.ts",
      "tests/e2e/public-data-analytics-stdio.test.ts",
      "tests/e2e/dashboard-strategy-stdio.test.ts",
      "tests/e2e/data-analytics-documentation.test.ts",
    ]) {
      expect(manifest.scripts.smoke).toContain(suite);
    }
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
      "内容生成",
    ]) {
      expect(readme, `README must disclose ${required}`).toContain(required);
    }
    expect(readme).not.toContain("不提供仪表盘");
    for (const required of [
      "数据/竞对/分析 → 五类看板 → 下钻 → 建议 → 修改/拒绝/重排/补充任务 → 重启",
      "dashboard_render",
      "dashboard_get",
      "dashboard_artifact_get",
      "dashboard_drilldown_get",
      "strategy_recommendation_generate",
      "strategy_task_supplement",
      "strategy_task_update",
      "strategy_task_reject",
      "strategy_task_reorder",
      "strategy_task_get",
      "strategy_task_list",
      "trend",
      "structure",
      "funnel",
      "competitor_comparison",
      "task_effect",
      "controlled_renderer",
      "controlled_html_svg_v1",
      "professionalTool: false",
      "Power BI",
      "32 KiB",
      "SHA-256",
      "内容寻址不等于加密",
      "TASK_NOT_LINKED",
      "不可验证",
      "analysis_graph_get",
      "evidence_asset_get",
      "targetChannels",
      "affectedStage",
      "expectedMetrics",
      "0.1",
      "0.15",
      "absoluteDelta",
      "relativeDelta",
      "not_established",
      "expectedVersion",
      "幂等",
      "(rank,id)",
      "observed_change_not_causal",
      "非因果",
      "不自动生产内容、审核、排期或发布",
    ]) {
      expect(readme, `README must disclose ${required}`).toContain(required);
    }
  });
});

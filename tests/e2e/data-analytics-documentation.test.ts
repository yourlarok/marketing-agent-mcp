import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("data analytics smoke and documentation contracts", () => {
  it("retains every stdio suite and includes content production in npm smoke", async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: { smoke: string };
    };
    for (const suite of [
      "tests/e2e/stdio.test.ts",
      "tests/e2e/data-research-stdio.test.ts",
      "tests/e2e/analysis-stdio.test.ts",
      "tests/e2e/public-data-analytics-stdio.test.ts",
      "tests/e2e/dashboard-strategy-stdio.test.ts",
      "tests/e2e/content-production-stdio.test.ts",
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
    for (const required of [
      "benchmark_reverse_create",
      "benchmark_reverse_get",
      "content_brief_create",
      "content_brief_get",
      "content_asset_generate",
      "content_asset_derive",
      "content_asset_get",
      "content_artifact_get",
      "MARKETING_BENCHMARK_MCP_COMMAND",
      "MARKETING_BENCHMARK_MCP_ARGS",
      "MARKETING_MEDIA_MCP_COMMAND",
      "MARKETING_MEDIA_MCP_ARGS",
      "MARKETING_MEDIA_MCP_ENV_ALLOWLIST",
      "MARKETING_FFPROBE_COMMAND",
      "不制造 `video_frames` 或 `asr_transcript`",
      "high|medium|low|unknown",
      "宿主用户原始语言",
      "findingId",
      "xhs_png_1080x1440_v1",
      "channels_mp4_1080x1920_h264_aac_v1",
      "internal_acceptance_only",
      "分别调用 generate/derive",
      "inputHash",
      "expectedParentVersion",
      "32,768 bytes",
      "sourceVersions",
      "不留下成功的 BenchmarkAnalysis/AssetVersion",
      "不是 OS 沙箱",
      "MARKETING_TEST_FFMPEG",
      "MARKETING_TEST_FFPROBE",
      "2,000 ms",
      "50 ms",
      "效果复盘",
    ]) {
      expect(readme, `README must disclose content production contract ${required}`).toContain(required);
    }
    expect(readme).not.toContain("不提供内容生成、逆向制作");
  });

  it("documents all 17 publishing and effect tools and the 71-tool operational contract", async () => {
    const readme = await readFile(join(projectRoot, "README.md"), "utf8");
    for (const required of [
      "approval_record", "approval_get", "schedule_create", "schedule_reschedule", "schedule_cancel",
      "schedule_get", "publication_submit", "publication_verify", "publication_retry", "publication_get",
      "publication_manual_handoff", "publication_manual_complete", "delivery_package_get",
      "effect_metric_snapshot_import", "effect_metric_snapshot_get", "effect_review_create", "effect_review_get",
      "MARKETING_PUBLISHING_MCP_COMMAND", "MARKETING_PUBLISHING_MCP_ARGS",
      "MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST", "publish:v1:", "operationKey", "not_found",
      "startup", "overdue", "SIGINT", "SIGTERM", "manual_evidence", "manual_assisted",
      "not_published", "owned_operating", "owned_conversion", "interactionRate", "profileVisitRate",
      "leadRate", "purchaseRate", "automaticVerifiedRate", "zero_denominator", "not_established",
      "32,768", "64 KiB", "71", "17 个发布与效果工具",
    ]) expect(readme, `README must disclose publishing/effect contract ${required}`).toContain(required);
    expect(readme).not.toContain("当前没有内容审批、自动排期、发布或生成资产效果复盘工具");
    expect(readme).not.toContain("当前不提供内容审批执行、自动排期、发布或生成资产效果复盘");
  });
});

# Marketing Agent MCP

通过 stdio 提供营销审计、数据准备、证据资产、受控公开研究、确定性竞品比较、版本化分析网络、证据绑定逆向和原创内容生成资产的 MCP server。所有实体按 `workspaceId` 隔离；写操作保留审计与幂等记录。

## 环境要求与安装

- Node.js **22.23.1 或更高版本**（使用内置 `node:sqlite`）。
- npm。
- 内容链接或公开研究需要 Playwright Chromium；仅做元数据和文件/API 导入时可不启动浏览器。

```bash
npm ci
npx playwright install chromium
npm run build
mkdir -p /absolute/path/to/marketing-data
mkdir -p /absolute/path/to/marketing-imports
mkdir -p /absolute/path/to/marketing-artifacts
```

Linux 若缺少 Chromium 系统依赖，可按 Playwright 官方提示安装对应依赖。`npm run smoke` 会启动真 Chromium，不会用模拟浏览器替代；缺少浏览器时必须先执行上述安装命令。内容生产 smoke 还要求可信本地 ffmpeg/ffprobe：测试用 `MARKETING_TEST_FFMPEG` 和 `MARKETING_TEST_FFPROBE` 指定精确绝对路径（未设置时使用 `/opt/homebrew/bin/ffmpeg` 与 `/opt/homebrew/bin/ffprobe`）。ffmpeg 仅供独立测试 media fixture 生成真实 PNG/MP4；ffprobe 同时用于 server 验收和测试独立复核，不可跳过或用签名/描述符代替。

启动、构建和测试均应在项目根目录执行。server 入口是构建后的 `dist/index.js`，不是源码或 `node_modules`。

## 数据、导入与证据目录

| 环境变量 | 用途与要求 |
| --- | --- |
| `MARKETING_DATA_DIR` | 必填，必须是已存在目录。SQLite 位于其中的 `marketing.db`。 |
| `MARKETING_IMPORT_ROOT` | 文件导入必填，必须是已存在目录。`ingest_files.paths` 使用相对该目录的路径；绝对路径、`..` 和解析后越界的符号链接均不能绕过目录边界。 |
| `MARKETING_DATABASE_ROOT` | SQLite discover/snapshot 必填，必须是已存在且明确授权的数据库目录。只允许读取 canonical path 仍位于该根内的普通 `.sqlite` / `.db` 文件。 |
| `MARKETING_ARTIFACT_DIR` | 产生或读取证据资产时必填。首次使用时自动创建并设为私有目录权限；原始文件/API 响应、规范化 JSONL、质量报告、页面正文、PNG 截图、持久化视频帧/ASR（若另行取得）以及生成资产按 SHA-256 内容寻址保存。 |
| `MARKETING_BENCHMARK_MCP_COMMAND` / `MARKETING_BENCHMARK_MCP_ARGS` | 可选但逆向必需；受信任 stdio reverse provider 的固定 executable 与 JSON 字符串数组参数。 |
| `MARKETING_MEDIA_MCP_COMMAND` / `MARKETING_MEDIA_MCP_ARGS` | 可选但生成/派生必需；受信任 stdio media provider 的固定 executable 与 JSON 字符串数组参数。 |
| `MARKETING_MEDIA_MCP_ENV_ALLOWLIST` | 可选；媒体 provider 可接收的部署环境变量名逗号列表，不能由工具调用覆盖。 |
| `MARKETING_FFPROBE_COMMAND` | Channels 验收必需；独立可信 ffprobe 的绝对 executable path。 |
| `MARKETING_PUBLISHING_MCP_COMMAND` / `MARKETING_PUBLISHING_MCP_ARGS` | 可选但 automatic 发布必需；受信任 stdio publishing provider 的固定 executable 与 JSON 字符串数组参数。 |
| `MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST` | 可选；publishing provider 可接收的部署环境变量名逗号列表，不能由工具调用覆盖。 |

仅使用血缘工具时不需要 import/artifact root。import root 中的输入文件和 artifact root 中的证据应分别授权；不要因为导入目录可读就把证据目录暴露给其他用户。

备份时应同时取得一致的 SQLite 与 artifact root 快照，并避免在写入期间复制。只有数据库而没有哈希对应的 artifact 文件，无法读取证据正文。删除任一目录都可能永久丢失记录或证据。

## MCP 客户端注册

先构建，再把下面配置合并到 MCP 客户端。路径必须替换为本机绝对路径。

```json
{
  "mcpServers": {
    "marketing-agent": {
      "command": "node",
      "args": [
        "/absolute/path/to/marketing-agent-mcp/dist/index.js"
      ],
      "env": {
        "MARKETING_DATA_DIR": "/absolute/path/to/marketing-data",
        "MARKETING_IMPORT_ROOT": "/absolute/path/to/marketing-imports",
        "MARKETING_ARTIFACT_DIR": "/absolute/path/to/marketing-artifacts",
        "MARKETING_HTTP_ALLOWLIST": "127.0.0.1",
        "MARKETING_HTTP_CREDENTIAL_ALLOWLIST": "TEMPORARY_API_TOKEN",
        "TEMPORARY_API_TOKEN": "<YOUR_TEMPORARY_API_TOKEN>"
      }
    }
  }
}
```

上面的 loopback 和测试凭据配置只适用于明确授权的本地 fixture。生产环境应删除不需要的 loopback 条目，只配置实际使用的凭据变量名，并使用客户端的秘密管理机制，不要把真实秘密提交到仓库。

手动诊断启动：

```bash
MARKETING_DATA_DIR=/absolute/path/to/marketing-data \
MARKETING_IMPORT_ROOT=/absolute/path/to/marketing-imports \
MARKETING_ARTIFACT_DIR=/absolute/path/to/marketing-artifacts \
node dist/index.js
```

该进程是 stdio MCP server，不是 HTTP 服务，也不提供浏览器调试端口。stdout 只承载 MCP/JSON-RPC；诊断信息写 stderr。配置或数据库启动失败会在 stderr 报告原因并非零退出。

## 网络目标与凭据边界

### 目标 allowlist 与研究 scope

`MARKETING_HTTP_ALLOWLIST` 是逗号分隔的**主机名**列表，不带 scheme、端口或路径，供临时 API 和 Chromium 共同使用。它的作用是显式允许本会被拦截的 loopback、私网、link-local 等地址，例如 `127.0.0.1`；它不是公网域名白名单，也不会代替研究范围检查。

公开研究的每个请求还必须满足 session 的 `scope.hosts` 和 `scope.pathPrefixes`。因此本地测试通常同时需要：

- `MARKETING_HTTP_ALLOWLIST=127.0.0.1`，允许访问 loopback fixture；
- `scope.hosts: ["127.0.0.1"]` 与明确的 `pathPrefixes`，限制实际研究页面。

不要为绕过目标限制而使用宽范围网段、不受控代理解析或重定向。临时 API 与 Chromium 都会验证解析地址；重定向也会重新验证，下载、WebSocket 升级和 URL userinfo 不受支持。

### 临时 API 凭据引用

`ingest_temporary_api` 不接受明文秘密。需要认证时：

1. 把变量名加入 `MARKETING_HTTP_CREDENTIAL_ALLOWLIST`，多个名称用逗号分隔。
2. 把实际值放入 server 进程环境中的该变量。
3. 工具参数只传 `credentialRef: "env:TEMPORARY_API_TOKEN"`。

server 将值作为 `Authorization: Bearer ...` 发送；跨 origin 重定向不转发认证。引用未 allowlist、变量缺失、值含换行或凭据以其他形式传入都会失败。不要把秘密写进 URL、工具参数、证据定位符、日志或测试快照。

API 还必须具有 `owned` 或 `authorized` 所有权，并提供未来的 UTC `expiresAt`。支持 JSON 对象数组（仅标量字段）或 CSV 响应；不会摄取未授权公开 API。

## Playwright 与专业内容 MCP

未配置专业 MCP 时，内容采集使用 headless Chromium。每次采集都会建立目标固定代理和独立 browser context，禁用下载与 service worker，提取正文、可选 CSS 字段、链接和 PNG 截图；结束后关闭 context、Chromium 和代理。登录、CAPTCHA、401/403/429 等访问缺口不会被绕过。

可选地配置用户自行获得并信任的专业 MCP：

```json
{
  "MARKETING_CONTENT_MCP_COMMAND": "/absolute/path/to/professional-content-mcp",
  "MARKETING_CONTENT_MCP_ARGS": "[\"--stdio\"]"
}
```

- command 是部署方配置的固定可执行文件；args 必须是 **JSON 字符串数组**，不是 shell 命令行。配置 args 时必须同时配置 command。
- server 每次采集启动该 stdio MCP，并调用其 `acquire_content` 工具，参数包含 `url`、`fields`、可选 `scope`、`maxBytes` 和 `timeoutMs`。
- 对带 `scope` 的采集，server 会在**同一 provider 进程的业务请求之前**启动真实 loopback canary 监听器，并发送一个越界 URL。provider 或其代理必须返回 `SCOPE_DENIED`，且以 `enforcement: "provider_pre_request" | "proxy_pre_request"` 明确声明请求前拒绝；canary 实际命中必须为 0。忽略 scope、先请求再拒绝或伪造合法 `finalUrl` 的 provider 都不可 verified，并按不可用处理。`pathPrefixes: ["/"]` 等无法生成越界 canary 的 scope 也不能通过专业 MCP 验证，可回退到自身带固定代理的 Chromium。
- 成功结果必须在 `structuredContent` 中提供 `url`、`finalUrl`、`title`、`text`、`fields`、可选 `links` 和有效 PNG 的 `screenshotBase64`。URL origin、字段集合、研究 scope、大小与 PNG 完整性都会再次校验；这些响应校验是纵深防御，不能替代上述请求前验收。
- 专业 MCP 的普通不可用/协议失败可回退到 Chromium；访问缺口、scope 拒绝和研究预算边界不会用 fallback 绕过。
- 每次调用结束都会关闭专业 MCP client。server 默认不把任意业务环境变量或凭据转发给该子进程；供应商认证应由其自身受控配置完成。
- 本项目不附带或安装特定供应商的专业 MCP，也不保证任何第三方工具可用。命令配置属于受信任部署配置，不是工具调用方可注入的脚本入口。canary 是对配置 provider/代理行为的验收，不是操作系统网络沙箱；部署方仍须信任 provider 的启动代码及其运行账户，并以容器或主机网络策略约束其他出站访问。

## 数据准备与研究流程

所有写工具都需要 `actor`、`requestId` 和 `idempotencyKey`。时间戳使用 UTC ISO-8601。使用 `expectedVersion` / `expectedPlanVersion` 的命令必须传入当前版本；相同幂等键和相同输入可安全重放，不同输入会被拒绝。

### 1. 计划、文件和质量报告

1. 用 `workspace_create` 创建工作区。
2. 用 `data_request_plan` 声明目标、`questionTypes` 与当前 `availableFields`，得到第 1 轮计划。
3. 用 `ingest_files` 导入 CSV/XLSX；关联计划时同时传 `planId` 和当前 `expectedPlanVersion`。一次可传多个路径，XLSX 每个 sheet 形成独立 Dataset/Evidence。可选 `ownership` 为 `owned`（默认）、`authorized` 或 `external_public`；公开导出快照必须显式标为 `external_public`，其 Evidence 会记为 `external_observation`，不得把公开数据伪装成自有数据。
4. 读取 batch 返回的 `datasetIds` / `evidenceIds`。每个数据集保存原始资产、规范化 JSONL 和质量报告；质量统计与 issue 包括行列数、逐字段/总缺失单元格、重复/空行、类型不一致、重复/空表头、列数不一致和缺失公式缓存值。`coverageStart` / `coverageEnd` 从 `published_at`、`converted_at` 或 `stage_changed_at` 的实际有效值提取；无法确定时为 `null`，不会写入导入时间。
5. 成功导入会推进计划轮次并保留各 dataset 的质量描述。一个问题只有在**单一 dataset** 同时提供全部必需字段、至少一行数据、每个必需字段至少一个非空值且数据未 stale 时才可 answerable；零行、必需字段全空、stale 和跨 dataset 拼字段都不能进入 `ready`。后续有效 dataset 可在下一轮推进。用 `data_request_decline` 拒绝某一轮时必须给出限制原因。

支持的问题类型为 `content_performance`、`lead_funnel`、`conversion`、`competitor_content`。XLSX 公式不会重新计算，缺失缓存结果会作为质量限制保留。

### 2. 临时 API

`ingest_temporary_api` 获取已授权且未过期的 JSON/CSV，生成与文件导入一致的 Source、Dataset、Evidence、质量与血缘资产。可关联计划推进下一轮。HTTP 或解析失败会返回错误，不会伪装成空数据成功。

### 3. 内容链接与竞品

`ingest_content_links.links` 每项包含公开 URL 和可选 CSS selector map。每个成功页面保存正文和截图证据，并创建初始为 `excluded`、关联该证据的 competitor 候选；候选不代表人工认可。

检查候选后，用 `competitor_confirm` 将状态改为 `confirmed` 或保持/改为 `excluded`。只有两个已确认 competitor 才能通过 `competitor_diff_create` 比较。Diff 仅基于合格研究/内容采集证据中的结构化字段，结果为 `same`、`different` 或 `unknown`，并链接证据；不会生成语义结论或 Finding。

### 4. 有权限边界的公开研究

1. `research_session_create` 提供 goal、seeds、是否请求 expansion，以及完整 scope/limits。所有 seed 必须位于 scope 内。
2. `expansion: true` 的 session 初始为 `awaiting_permission`。用 `research_permission_set` 明确选择 `allowed` 或 `denied`。
3. 用 `research_session_run` 执行。未授权 expansion 时仍可处理 seed，但以 `permission_required` 部分停止；拒绝后仅处理 seed；允许后仅沿同 host、同 path prefix 的链接扩展。
4. 查看 `state`、`stopReason`、`gaps`、`frontier`、`visitedUrls`、`attemptCount`、`candidateBytes` 与 `elapsedMs`。运行时 limits 只能调低，不能超过 session 已配置上限。`maxDepth: 0` 在 create/run 均合法，表示只处理 seeds、不沿链接扩展；其他预算仍必须为正数。

完成的研究 session 不能随意重跑；等待权限的 seed-only 部分结果可在授权后继续保留的 frontier。

### 5. 血缘、重启与证据读取

`data_research_get` 可读取 `data_request_plan`、`ingestion_batch`、`research_session`、`competitor`、`competitor_diff` 的工作区血缘与审计 request ID，并返回完整 `entity` 和继续流程所需的 `descriptors`：plan rounds/questions/batch refs、batch 的 Source/Dataset/Evidence、session/competitor 的 Evidence（含 assets）、Diff entries/competitors/findings。`ingest_content_links` 同时返回 `competitorIds`，业务衔接不需要直接 SQL。原 `lineage_get` 继续读取营销任务链。

`evidence_asset_get` 只接受 `workspaceId`、`evidenceId`、`assetId` 以及可选 `offset` / `length`，不接受文件路径。`offset` 默认 0，`length` 默认且最大 32 KiB 原始字节；响应只含当前块的 base64 `content`，并返回当前 `offset`、块 `length`、`totalBytes` 和完整资产的 `contentHash`。小资产的旧调用仍返回完整内容；大资产按 offset 逐块读取并在拼回后校验 SHA-256。Evidence 的 `assets` 元数据提供 asset ID 与 kind。

SQLite、实体版本、审计和幂等结果在同一数据目录重启后保留；artifact 通过内容哈希重新读取。重启后可仅用 `data_research_get` 恢复 plan/session/diff payload 和资产描述，再用 `evidence_asset_get` 读取正文。

## 授权 SQLite 快照

`connector_sqlite_discover` 只发现 `MARKETING_DATABASE_ROOT` 中指定 database ID 的普通表结构，不读取业务行。`ingest_sqlite` 再通过结构化 query 读取快照并生成 Source、Dataset、Evidence、规范化 JSONL 和质量报告。典型顺序是先 discover，再以 `query: { databaseId, table, columns, filters, order, limit }` 调用 ingest，随后用 `data_research_get` 和 `evidence_asset_get` 恢复血缘与 snapshot 资产。

- 授权根必须是部署方明确授权的已存在目录。database ID 只能是受控标识及可选 `.sqlite` / `.db` 后缀；绝对路径、`..`、根外解析、符号链接和非普通文件均被拒绝。打开时还会校验描述符与文件身份，并以只读、`query_only` 方式访问。
- 这不是任意 SQL 接口。只能选择已发现表中的列、等值/`IS NULL` filters、受控升降序和行数 limit；server 构造参数化查询并追加稳定排序。调用方不能传 SQL 字符串、join、子查询、写语句或 PRAGMA。
- 每次 ingest 都是调用时生成的**显式快照**，保存 query hash、observedAt、来源描述和内容 hash；不是实时同步、订阅或持续连接。源库之后的变化不会自动进入 Dataset，必须再次显式 ingest 形成新快照。
- 仅接受 `owned` 或 `authorized` 数据。视图、BLOB、非有限数值和超出安全整数范围的 SQLite integer 不受支持；不能把它当作任意 SQLite 数据库的通用导入器。
- 当前不支持 WAL 数据库。授权校验后会检查 `-wal` 侧车与 `journal_mode`，WAL 在 discover 或 snapshot 读取任何 schema/业务行之前以受控 `CAPABILITY_UNAVAILABLE`（`reason=wal_not_supported`）失败，不会退回主文件旧数据。调用方应先由可信来源完成 checkpoint 并转换为非 WAL 快照。
- 当前文件描述符传递实现依赖 POSIX 风格 `/dev/fd/<fd>`，供 `node:sqlite` 打开已经完成授权校验的描述符。没有兼容 `/dev/fd` 的平台（包括原生 Windows）不支持此 SQLite connector；这不是可移植的纯路径实现，也不影响不使用该 connector 的其他工具。

## 外部分析 MCP

`professional_analytics_compute` 不是内置统计按钮：它要求部署方另行安装、授权并信任一个真正提供 stdio `analyze` 工具的外部 MCP。项目不附带生产供应商，也不会在未配置时用内置参考函数冒充外部分析。

```json
{
  "MARKETING_ANALYTICS_MCP_COMMAND": "/absolute/path/to/professional-analytics-mcp",
  "MARKETING_ANALYTICS_MCP_ARGS": "[\"--stdio\"]"
}
```

command 是受信任部署配置中的固定可执行文件；args 必须是 **JSON 字符串数组**，配置 args 时必须同时配置 command，不会拼接成 shell 命令。支持受控 `trend_v1`、`funnel_v1`、`anomaly_v1`，输入只能引用已导入且同 batch 配对的 Dataset/Evidence/normalized_jsonl。每次调用启动独立 provider 进程，结束后关闭 client，并在异常时按超时和退出边界清理；默认不转发业务环境变量或凭据。

未配置时，`marketing_capability_list` 将 `analytics.professional` 标为 `unavailable`，真实公开工具返回 `CAPABILITY_UNAVAILABLE`、`mcp_not_configured` 和包含上述环境变量的 `configurationAction`，不会写入图或返回本地替代结果。provider 启动、协议、超时、响应校验或清理失败同样作为 capability gap 报告。

server 对 canonical operation + rows 计算 SHA-256 `inputHash`，要求 provider 返回相同 hash，并用独立内置参考实现**复算核对**结果；hash 不符、结构不合法或数值不一致都会失败。复算只是验收外部结果，不是未配置 fallback。节点 provenance 保存 input hash、provider/tool version、行数以及 batch/dataset/evidence/asset ID 和内容 hash，便于重启后审计。

硬上限为每次 100,000 行、provider 原始响应 16 MiB、15 秒超时；MCP 工具输出仍受 64 KiB 限制，trend 窗口、anomaly 数量和 funnel stage 也有边界。外部 MCP 的 command 属于受信任代码执行配置，响应校验与进程清理**不是 OS 沙箱**：部署方仍须用独立账户、容器和主机资源/网络策略限制 provider 的文件、进程和出站访问。

## 分析网络

普通用户只需对 Agent 说一句话，例如：**“我没有业务数据，想了解 AI 教育怎么营销。”** Agent 应先调用 `marketing_analysis_start`；默认 `inputMode=none` 会创建 question 与 `public_research` 分支，最多提出一个可跳过的关键问题，并给出宿主搜索或限域研究的下一步。它不要求 CSV，也不会假装研究已经完成。自有数据是可选增强；公开互动不能推断成 CTR、转化或因果效果。

`marketing_capability_list` 说明操作、所需输入/配置、可用性、fallback 与限制。`host_provided` 只表示能力须由宿主实际提供，`not_installed` 的 live connector 占位说明不能被当作已安装或可用能力。

### 9 个分析工具

- `marketing_analysis_start`：按 `none|links|dataset|api` 创建分析图和结构化 recommended actions；`dataset` 模式用 `referenceId` 引用已导入 Dataset。
- `marketing_capability_list`：发现真实能力、配置和边界，不是安装或健康证明。
- `analysis_graph_get`：按 `workspaceId` 与图 ID 恢复完整图、节点 payload、边和引用。
- `analysis_graph_expand`：用当前 `expectedVersion` 原子追加受控节点/边，可从任意现有节点扩展；拒绝环、重复和孤儿引用。通用扩展只允许调用方创建 `question|research|dataset|decision`，`metric|analytics|scenario|monitor` 只能由对应真实计算命令生成。
- `analysis_graph_fork`：深拷贝独立分支并记录 `parentGraphId`、`parentVersion`、`forkNodeId`；父图不变，本批不做分支合并。
- `metric_compute`：从同 batch 的 Dataset、Evidence 与 `normalized_jsonl` 计算受控指标，并校验 hash、字节数和质量报告。
- `professional_analytics_compute`：调用已配置的真实外部分析 MCP，复算核对 trend/funnel/anomaly 并保存完整证据 provenance；未配置时明确不可用。
- `metric_scenario_create`：从当前 Metric 节点创建明确假设的条件化算术情景。
- `metric_monitor_compare`：用新导入快照按同一定义重算并做一次显式对比，可链接同图 Scenario。

所有写工具仍需写上下文和幂等键。图变更使用乐观版本；重启后只需公开 `analysis_graph_get` 即可恢复结果，不需要带外 SQL。

### 指标、严格数值与 complete-case

| 指标 | 数学定义 | 角色与边界 | minimumDenominator |
| --- | --- | --- | --- |
| `ctr_v1` | `sum(clicks) / sum(impressions)` | 曝光到点击的过程效率；不是转化率，也不证明因果 | 1000 |
| `save_like_ratio_v1` | `sum(saves) / sum(likes)` | 收藏相对点赞的互动构成；不是收藏率、转化率或 CTR | 30 |
| `engagement_rate_v1` | `(sum(likes) + sum(saves) + sum(comments)) / sum(impressions)` | 复合互动效率；同一曝光可有多种互动，不是独立人数、转化率或因果效果 | 1000 |
| `conversion_rate_v1` | `sum(conversions) / sum(clicks)` | 点击到转化的过程效率；只允许 owned/authorized，external_public 明确拒绝，不证明增量或因果 | 100 |

只纳入同一行分子、分母均为有限非负数的 complete-case 行。数值必须是 number，或匹配严格十进制/科学计数法的字符串，再转换为 IEEE-754；缺失、空字符串、负数、非数值、NaN/Infinity 都排除，不得当作 0。结果保留总行数、纳入/排除行数和逐行排除原因，使用 `ieee754_compensated_sum` 补偿求和，不做未声明的显示舍入。

没有有效行、分母合计为 0 或合计/比值超出有限数值范围时，`status=unknown`、`value=null`，分别给出 `NO_VALID_ROWS`、`ZERO_DENOMINATOR` 或 `NON_FINITE_TOTAL`；零分母不能返回 0。结果同时保存公式、定义版本、分子、分母、覆盖时间、输入 ID、证据 hash、质量限制和参考度。

### Wilson 95% 区间与适用性

`proportionAssessment` 对 eligible 的 CTR/conversion 计数给出 Wilson score 95% 区间。其假设是分子和分母来自**独立同分布（IID）Bernoulli trials**；区间只描述该比例的抽样不确定性，不是营销提升概率，只能作非因果解释，也不能证明增量效果。曝光、点击或用户之间相关、重复计数、归因口径不一致或试验条件不同时，即使返回算术区间也不能把它当作已满足这些统计假设。

以下情况为 `not_applicable`、`interval=null`：engagement/save-like 等非 binomial eligible 指标，unknown/零分母/非有限合计，非安全整数计数，分子大于分母，以及分母低于上表 minimumDenominator。engagement 因一次曝光可产生多种互动而明确不适用 Wilson；conversion 除上述条件外仍受 owned/authorized 权限边界约束，不能从公开互动推导。

### 参考度 exact rubric

`referenceAssessment` 只有 `high|medium|low|unknown`，附机器可读 reason codes、简短说明以及 provenance、freshness、sample、missingness、comparability 五个维度；它不是主观置信概率，也不衡量因果强度。规则固定如下：

1. 计算为 unknown 时，参考度必为 unknown。
2. `comparability=not_comparable` 时，参考度必为 low。
3. 对可计算结果，统计三类质量问题：分母低于该指标 minimumDenominator、stale、存在排除行。两类及以上为 low；恰好一类时，owned/authorized 为 medium，external_public 为 low。
4. 没有这三类问题时，external_public 最高 medium。
5. 没有这三类问题时，owned/authorized 只有 `comparability=comparable` 才为 high；默认 `not_assessed` 最高 medium。数值可复算不等于已做同类标杆校验。

对应 reason codes 包括 `NO_VALID_ROWS`、`ZERO_DENOMINATOR`、`NON_FINITE_TOTAL`、`COMPARABILITY_NOT_COMPARABLE`、`SAMPLE_BELOW_MINIMUM`、`STALE_DATA`、`EXCLUDED_ROWS`、`EXTERNAL_PUBLIC`、`COMPARABILITY_NOT_ASSESSED`。

### 条件情景与监控

`metric_scenario_create` 要求 `conservative|base|optimistic` 标签、有限非负 `targetValue` 和 `projectedDenominator`。它计算 `targetValue - baselineValue`、相对变化、`targetValue * projectedDenominator` 及预测分子相对基线分子的增量；基线为 0 时相对变化为 null 并标记 `ZERO_BASELINE`，unknown 基线保持 unknown。投影固定使用调用方给的预测分母并假设其他条件不变，分母变化也会影响预测分子增量；这些是敏感性算术，不是提升保证或因果预测。

`metric_monitor_compare` 比较值、绝对/相对变化、参考度和样本变化。基线或新值 unknown 时对比为 unknown、delta 为 null；基线为 0 时相对变化为 null。它只执行一次调用，返回 guardrail 与复盘条件，`scheduling=not_provided`，不会创建定时任务、 recurring monitor 或自动调度。

## 受控看板与策略任务

完整公开流程是：**数据/竞对/分析 → 五类看板 → 下钻 → 建议 → 修改/拒绝/重排/补充任务 → 重启**。每一步只使用前一步持久化的公开 ID 与描述符，不需要带外 SQL。

### 11 个看板与策略工具

- `dashboard_render` 从 persisted Snapshot 渲染或按 `expectedVersion` 替换看板；`dashboard_get` 恢复元数据；`dashboard_artifact_get` 分块读取 artifact；`dashboard_drilldown_get` 读取单个 datum 的真实引用。
- `strategy_recommendation_generate` 从证据支持的 Finding 和可选 AnalysisGraph 节点生成建议。
- `strategy_task_supplement`、`strategy_task_update`、`strategy_task_reject`、`strategy_task_reorder` 分别补充、修改、拒绝和重排用户控制的 Task；`strategy_task_get` 读取完整状态，`strategy_task_list` 按确定顺序分页。

### 五类 view 与来源要求

| view kind | 必需来源 |
| --- | --- |
| `trend` | 同图真实外部分析 `trend_v1` Analytics 节点 |
| `structure` | 同图 Metric 节点；多个节点必须具有相同 metric ID 与定义版本 |
| `funnel` | 同图恰好一个真实外部分析 `funnel_v1` Analytics 节点 |
| `competitor_comparison` | 两个已确认竞对形成的 persisted CompetitorDiff |
| `task_effect` | 同图 Monitor 与 Task/Recommendation 的指标链接；空 `taskIds` 返回 `TASK_NOT_LINKED` 和可见的 `不可验证`，不制造效果值 |

每个 view 显示来源、来源更新时间 `sourceUpdatedAt`、证据观察时间 `dataAsOf`、指标公式/定义版本、证据与图引用以及 unknown 原因。renderer 固定为 `type: controlled_renderer`、`id: controlled_html_svg_v1`、`professionalTool: false`。它是项目内受控 HTML/SVG renderer，**不是 Power BI 或专业 BI 工具**，不执行 artifact 中的脚本，也不调用外部看板服务。

### 双 artifact、下钻与重启恢复

每次 render 生成 HTML 与 JSON manifest 两个真实 artifact，描述符包含准确字节长度和 64 位十六进制 SHA-256 `contentHash`。`dashboard_artifact_get` 的 `offset` / `length` 按原始字节读取，单块最大 **32 KiB**，内容为 base64；调用方按 offset 拼回后必须校验 SHA-256。单 artifact 最大 1 MiB。内容寻址用于完整性校验与恢复，**内容寻址不等于加密**。

HTML 中每个 datum anchor 都对应 `viewId` / `datumId`。将二者传给 `dashboard_drilldown_get` 可取得 Dataset、Evidence 与 AnalysisGraph refs；再用 `analysis_graph_get` 和 `evidence_asset_get` 验证节点及证据正文确实存在。trend、funnel、competitor 与已链接 task observation 都遵循这一证据路径。

同一 data/artifact 目录重启后，`dashboard_get` 恢复最新版本和替换后的 artifact 描述符，分块读取、下钻、Recommendation 血缘及完整 Task 状态仍可恢复。备份仍需一致保存 SQLite 与 artifact root。

### 建议字段、数学与非因果边界

先用 `finding_record` 记录带 `evidenceIds` 的 Finding，再调用 `strategy_recommendation_generate`。`affectedStage` 指定阶段，`targetChannels` 指定渠道，`expectedMetrics` 选择 `establish_baseline` 或链接真实 Metric/Scenario 的 `reach_scenario_target`；返回的 `evidenceIds` 与 `analysisNodeRefs` 保留 lineage。

例如 CTR baseline `0.1`、Scenario target `0.15`、预测分母 40,000 时，expected space 的 `absoluteDelta=0.05`、`relativeDelta=0.5`、预测分子为 6,000、分子增量为 2,000。算术直接来自 persisted Metric/Scenario，`causality=not_established`，不是提升承诺。

Task 完成后可将 Task 与对应 Monitor 链入新版 task-effect view。baseline/current 为 `0.1/0.2` 时，观察值 `absoluteDelta=0.1`、`relativeDelta=1`，解释固定为 `observed_change_not_causal`。这种前后观察是**非因果**描述，不能证明变化由 Task 导致。

### 用户控制、版本与幂等

补充 Task 时提供 `recommendationIds`、标题、`assignee`、优先级、数值 `rank`、依赖、素材要求和验收标准。修改可调整负责人、素材与验收等可变字段；拒绝必须给出原因。每次非重放命令只递增一次版本，更新/拒绝/重排及 Dashboard 替换要求当前 `expectedVersion`，stale version 会冲突。相同幂等键与相同输入的精确重放返回相同响应，不同输入复用该键会被拒绝。

`strategy_task_list` 按 **`(rank,id)`** 排序并提供有界 cursor；符合条件的 Task 仍通过既有 `task_transition` 显式执行 `draft → ready → in_progress → completed`。这些工具只管理用户控制的草稿与状态，**不自动生产内容、审核、排期或发布**，也不会创建相应工具调用或记录。

## 证据绑定逆向与原创内容生产

完整公开流程是：**合法公开页面与 CompetitorDiff → persisted BenchmarkAnalysis → 原创 ContentBrief → 分渠道生成/派生 AssetVersion → 分块读取与重启恢复**。每一步只使用公开工具返回的工作区 ID、版本和描述符；不接受 SQL、artifact 文件路径、调用方媒体字节或动态 provider 命令。

### 8 个工具与 persisted Evidence

- `benchmark_reverse_create` / `benchmark_reverse_get`：从选定 Evidence 创建、读取不可变的版本 1 BenchmarkAnalysis；可选关联当前版本的 CompetitorDiff。
- `content_brief_create` / `content_brief_get`：从 ready 或 in_progress Task、Recommendation、BenchmarkAnalysis 和事实 Finding 创建、读取不可变的版本 1 ContentBrief。
- `content_asset_generate` / `content_asset_derive` / `content_asset_get`：分别创建根资产、从最新父版本派生下一版本、读取任一持久化版本。
- `content_artifact_get`：按 AssetVersion 与 artifact ID 读取实际 PNG/MP4 字节，不提供路径访问。

`ingest_content_links` 和公开研究只持久化实际取得的 `page_text`、字段和 `screenshot` 等观察，**不制造 `video_frames` 或 `asr_transcript`**。图片逆向至少需要真实 page text 或 screenshot；视频逆向要求每个入选 Evidence 都已具有真实 persisted `video_frames` 和 `asr_transcript`。缺少任一资产时分别返回 `image_observation_missing`、`video_frames_missing` 或 `asr_transcript_missing` 的 `CAPABILITY_UNAVAILABLE`，不会用页面文字或图片冒充视频理解。

逆向 provider 必须返回与输入规范一致的 SHA-256 `inputHash`。server 重算并核对 hash，只接受实际送入的 Evidence asset refs，保留其 `observedAt`、字节数和 `contentHash`，再次验证观察 basis。每个 method 具有 `hook`、`information_order`、`layout`、`shot_rhythm`、`cta` 或 `other` 维度及 `high|medium|low|unknown` confidence；`unknown` 必须原样保留。`analysisMethod` 和 `humanReview: "not_performed"` 描述实际 fixture/provider 方法与人工审查边界，不包含原文 excerpt、虚构指标、因果效果或“人工看过视频”的声明。

### 宿主语言原创 brief 与事实引用

`content_brief_create` 要求使用**宿主用户原始语言**创作新表达，而不是拼接公开 benchmark 文本。`creative` segment 是原创表达；`fact` segment 必须通过 `findingId` 引用 persisted fact Finding，且该 Finding 有 Evidence 并属于当前 Recommendation 的 Finding/Evidence 上下文。未关联、跨工作区、非 fact 或无 Evidence 的引用会被拒绝。brief 自动派生 `findingIds`、`evidenceIds` 和带版本的 `sourceVersions`，调用方不能直接注入这些血缘字段。

公开来源文字与独立生产素材始终是两条通道：BenchmarkAnalysis 涉及的 Evidence 不能作为 production source，production source 必须另行具有 `owned` 或 `authorized` 权限。对公开文字中连续至少 40 个 Unicode code point 的规范化精确复用会拒绝 brief；这只是一项防直接复制检查，**不是版权、法律或原创性保证**。

XHS 与 Channels 必须分别创建 brief、分别调用 generate/derive，使用不同 `contentId`；没有批量双渠道生成或调用方 channel/profile override。Channels brief 可有多个镜头，每帧 `durationMs` 为正整数，总时长不超过 60,000 ms；例如两个镜头各 1,000 ms，合计 2,000 ms。

### 精确内部 profile、provider 与真实媒体验收

server 根据 persisted brief 选择下列固定 profile。它们是内部输入与验收规格，不是平台官方认证、发布许可或分发效果保证。

| channel / profileId | 实际输出与精确验收 | 上限 | guarantee |
| --- | --- | --- | --- |
| `xhs` / `xhs_png_1080x1440_v1` | PNG；真实 Playwright Chromium decode 后 natural size 必须为 **1080×1440** | 4 MiB | `internal_acceptance_only` |
| `channels` / `channels_mp4_1080x1920_h264_aac_v1` | 独立真实 ffprobe；恰好一个 **1080×1920 H.264** 视频流和一个 **AAC** 音频流，时长为正且不超过 60 秒 | 16 MiB | `internal_acceptance_only` |

逆向与媒体生成都需要部署方显式配置独立 stdio MCP。逆向固定调用 `reverse_engineer`，媒体固定调用 `render`；media provider 返回的 `inputHash`、media type、字节长度、SHA-256 `contentHash` 和实际存储字节必须一致。未配置时没有本地逆向或生成器 fallback，也不会把 fixture 或内置函数冒充商业 provider。

- `MARKETING_BENCHMARK_MCP_COMMAND` 与 JSON 字符串数组 `MARKETING_BENCHMARK_MCP_ARGS`：受信任部署配置；单 asset 16 MiB、合计 24 MiB、文字 1 MiB、provider 响应 1 MiB、60 秒超时、最多 20 个 methods。
- `MARKETING_MEDIA_MCP_COMMAND` 与 JSON 字符串数组 `MARKETING_MEDIA_MCP_ARGS`：受信任部署配置；provider 响应 24 MiB、120 秒超时；最多 8 个独立 source assets 加 1 个 parent，source/parent 合计 16 MiB。
- `MARKETING_MEDIA_MCP_ENV_ALLOWLIST`：逗号分隔的媒体 provider 环境变量名 allowlist。只有列出的部署变量可转发，工具调用方不能传 env；其他业务环境变量和凭据默认不进入 provider。
- `MARKETING_FFPROBE_COMMAND`：必须是部署控制的**绝对可执行路径**，独立于 media provider。每次 Channels generate/derive 对实际返回字节执行版本与媒体 probe；单次 10 秒、probe 输出 64 KiB。XHS 使用 Chromium decode，不借 ffprobe 代替。

每次调用使用独立受控 provider/client，并在成功、协议错误、超时或验证失败后清理进程；临时 probe 文件也会删除。响应 schema、输入输出字节、source/parent 总量、超时和环境转发均有硬边界。上述校验与进程清理**不是 OS 沙箱**，部署方仍需以独立账户、容器和主机资源/网络策略限制受信任 provider。

### 不可变派生、分块、重启与失败边界

根 AssetVersion 为版本 1 且 parent 为 null。derive 必须传当前最新 `parentVersionId` 和 `expectedParentVersion`，创建同一 `contentId` 的下一不可变版本，父版本保持不变；stale parent 返回 conflict。派生记录 parent artifact hash、实际 `revisionInstructions`、修改 actor、requestId、UTC createdAt、provider provenance 和新的实际内容 hash，并重新执行完整媒体验收。相同命令与 idempotency key 精确重放返回相同实体，不再次调用 provider；复用 key 但改变输入会被拒绝。提交前会重查 brief、Task、Recommendation、Finding、Evidence、Source、source materials、版本和 parent，防止准备期间的血缘变化被静默写入。

`content_artifact_get` 的 `offset` / `length` 以原始字节计，`length` 默认且最大 **32 KiB（32,768 bytes）**，响应为当前块的 base64、`totalBytes` 和完整资产 `contentHash`。调用方逐块拼回后必须独立计算 SHA-256；不得把单块 hash 当作整文件 hash。使用同一 data/artifact roots 重启后，只需 `benchmark_reverse_get`、`content_brief_get`、`content_asset_get`、`lineage_get` 和 `content_artifact_get` 即可恢复分析、brief、全部资产版本、Task/Recommendation/Finding/Evidence/parent 血缘与每个 artifact，无需 SQL 或路径。

provider 未配置、真实媒体缺失、decode/probe 失败或 hash 不符时返回结构化 capability gap；失败命令**不留下成功的 BenchmarkAnalysis/AssetVersion 版本、成功审计或幂等结果**，后续 get 为 NOT_FOUND。已通过内部验收不等于人工审核、法律放行、平台官方验证、排期、发布或效果复盘；这些后续步骤必须使用下列独立公开工具并取得相应验证。

## 审批、排期、发布与效果复盘

### 17 个发布与效果工具

- `approval_record` / `approval_get`：记录和读取人工声明的审批。Approval 锁定精确 AssetVersion、版本和实际 artifact hash；派生版本必须重新审批，旧 Approval 不转移。
- `schedule_create` / `schedule_reschedule` / `schedule_cancel` / `schedule_get`：创建、调整、取消和读取排期。创建同时产生 pending Publication；只有 scheduled 状态可用当前 `expectedVersion` 修改或取消。
- `publication_submit` / `publication_verify` / `publication_retry` / `publication_get`：提交、验证、恢复重试和读取 Publication。**submitted 不是 published**；submitting/submitted/unknown 必须先 verify，只有 provider 明确返回 `not_found` 才允许重新 submit，不能宣称未验证成功。
- `publication_manual_handoff` / `publication_manual_complete` / `delivery_package_get`：人工辅助交接、用 persisted Evidence 完成验证、分块读取交接包。`manual_assisted` 和 `manual_evidence` 始终与 automatic/provider verification 分开，不计为自动发布。
- `effect_metric_snapshot_import` / `effect_metric_snapshot_get` / `effect_review_create` / `effect_review_get`：导入、读取指标快照并创建、读取效率/内容/转化/自动化四段 EffectReview。

所有写工具仍需要 `actor`、`requestId`、`idempotencyKey`；公开参数只接受有界 ID、引用、UTC 时间、指标和状态，不接受 secret、path、command、code、env 或 raw media。完整 MCP 输入和每个响应均受 **64 KiB** 限制。`delivery_package_get` 每次最多返回 **32,768 bytes** 原始 JSON，经 adapter 转为 base64；包内含 locked brief/asset/artifact hash、channel/account、Schedule、Approval 和 operation key，明确标记 `not_published`，真实媒体仍只通过 `content_artifact_get` 读取。

### trusted provider、operation key 与恢复

自动排期和提交要求部署方显式配置 trusted stdio publishing provider，并在每次副作用前核对精确 channel/account、Approval、AssetVersion、artifact 和 due Schedule：

- `MARKETING_PUBLISHING_MCP_COMMAND` 与 JSON 字符串数组 `MARKETING_PUBLISHING_MCP_ARGS`：固定受信任 executable/args，不是调用方可注入的命令。
- `MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST`：可选的 provider 环境变量名逗号 allowlist；默认不转发业务环境或凭据。

未配置 provider 时全部 17 个工具仍注册，审批、排期、读取和 manual-assisted 路径可用，`publishing.automatic` 在 `marketing_capability_list` 中为 unavailable。仓库测试 fixture 只是独立 trusted provider 协议，不是小红书、视频号或任何商业平台官方集成，也不证明真实平台自动化。

`operationKey` 固定为 `publish:v1:<sha256>`，哈希输入是 canonical workspace/Schedule/AssetVersion/version/artifact hash/channel/account；重试、重启和外层 idempotency key 改变都不会改变它。provider 必须对同 key 不同 input hash  fail closed。接受提交后的超时或进程丢失记为 unknown，启动恢复先 verify，不重复提交。

scheduler 只存在于 server **process lifetime**：`startup` 会 catch up **overdue** Schedule 并恢复 submitting/submitted/unknown，single-flight tick 防止并发重复 claim。transport close、`SIGINT`、`SIGTERM` 使用同一关闭路径，先停止 scheduler 并等待 in-flight 工作，再关闭 MCP/SQLite。手动交接包可在重启后按 ID/hash 恢复。

### 人工证据与效果公式

`publication_manual_complete` 只接受当前工作区 owned/authorized Source 下的 persisted `owned_operating` Evidence，并记录 external Publication ID、publishedAt 和 `manual_evidence`；这不是 automatic publication，也不能用 manual 路径绕过 unknown/submitting 的 verify-first 要求。

指标快照只能引用 verified Publication 的精确版本和发布后的窗口。impressions/interactions/followers_gained/profile_visits 需要 `owned_operating` Evidence；leads/consultations/trials/purchases 需要 `owned_conversion` Evidence。EffectReview 公式固定为：

- `interactionRate = interactions / impressions`
- `profileVisitRate = profile_visits / impressions`
- `leadRate = leads / profile_visits`
- `purchaseRate = purchases / leads`
- `automaticVerifiedRate = automatic provider-verified Publications / selected Publications`

缺失指标、覆盖不完整或 `zero_denominator` 都返回 `value=null`、`status=unknown` 并保留已观察分子/分母，绝不把未知当 0。baseline delta 只是相同窗口/channel 的描述性算术；所有 section 都为 `causality=not_established`，小样本和前后对比不建立因果提升。`lineage_get` 额外支持 `approval`、`schedule`、`publication`、`metric_snapshot`、`effect_review` 五种类型，不新增血缘工具。

## 上限、部分失败与隐私

### 内置上限

调用方可设置更小的合法限制，不能通过请求抬高硬上限。

| 范围 | 上限 |
| --- | --- |
| MCP 输入 | 完整序列化参数 64 KiB；集合通常最多 1,000 项；严格字段与嵌套秘密字段名检查 |
| 文件/API 表格导入 | 单文件 25 MiB、100 文件、批次 100,000 行、500 列 |
| SQLite 结构化快照 | 100,000 行、500 列、100 个等值 filters |
| 规范化数据 | 单 Dataset JSONL 25 MiB；单批 JSONL 100 MiB |
| 外部分析 MCP | 100,000 行；原始响应 16 MiB；15 秒超时；结果仍受 MCP 输出 64 KiB 限制 |
| XLSX 解压 | 单 entry 64 MiB；workbook 合计 128 MiB |
| 临时 API HTTP | 响应 10 MiB；请求超时 10 秒；最多 5 次重定向 |
| 内容链接 | 每批 100 个；每页最多 50 个 CSS 字段 |
| Chromium/内容 MCP 采集 | 单次默认/最大 15 秒；PNG 截图最多 10 MiB |
| 研究 session | `maxDepth` 2、`maxPages` 20、`maxDurationMs` 60,000、`maxBytes` 20 MiB |
| 血缘读取 | 1,000 个节点 |

研究字节预算累计计算正文、字段名/值和截图，并计入已报告的失败候选消耗；时间预算跨 continuation 累计。

### 部分失败不是整体成功

- 文件和内容链接 batch：`completed` 表示无失败；`partial` 表示部分成功并保留 `failures`；`blocked` 表示全部失败。成功项及其证据会保留，失败项带 path 和安全消息。
- 临时 API 的准备/HTTP/解析失败会使该命令失败，不生成虚假的成功 batch。
- 研究逐页记录 `gaps`，成功证据不会因另一页失败而删除。`partial` / `blocked`、`stopReason` 和 gap reason 必须一起检查。
- 专业 MCP fallback、访问缺口、缺失字段、拒绝的数据轮次和 `unknown` Diff 都应作为限制呈现，不能改写为完整事实。

### 隐私与安全

- 仅导入有权使用的文件/API，仅采集可公开访问且允许自动访问的内容；遵守来源条款、 robots/访问控制和个人信息保留要求。本工具不会绕过登录、CAPTCHA 或反自动化边界。
- stdout 只用于协议。内部异常不会把堆栈或底层秘密细节作为工具结果返回。
- 不接受 URL 嵌入凭据或证据定位符中的秘密查询参数；拒绝含秘密字段名的工具输入；不执行调用方提供的脚本、任意命令或连接器。
- 数据库、导入文件、正文、截图和 API 响应都可能含敏感业务数据，应设置文件权限、加密/备份、保留与删除策略。artifact 内容寻址不等于加密。
- server 不提供多用户认证、远程访问控制、网络传输或数据库加密；这些边界由部署环境负责。

## 持久化与关闭

每次内容采集结束会关闭 Chromium、目标固定代理和专业内容 MCP client；每次外部分析、benchmark reverse、media render 和 publishing submit/verify 结束也会清理各自独立 provider/client 进程。server 响应 `SIGINT` / `SIGTERM`，先停止 publication scheduler 并等待 in-flight 工作，再关闭 MCP transport 和 SQLite；关闭 MCP client 也走同一清理路径。不要在写入或关闭过程中直接删除数据库或证据目录。

## 工具总览

| 类别 | 工具 |
| --- | --- |
| 工作区与营销血缘 | `workspace_create`、`source_register`、`dataset_register`、`evidence_record`、`finding_record`、`recommendation_create`、`task_create`、`task_transition`、`lineage_get` |
| 外部能力元数据 | `capability_register`、`capability_health_record`、`capability_list` |
| 数据计划与导入 | `data_request_plan`、`data_request_decline`、`ingest_files`、`ingest_temporary_api`、`ingest_content_links`、`connector_sqlite_discover`、`ingest_sqlite` |
| 公开研究 | `research_session_create`、`research_permission_set`、`research_session_run` |
| 竞品与证据 | `competitor_confirm`、`competitor_diff_create`、`data_research_get`、`evidence_asset_get` |
| 分析网络 | `marketing_analysis_start`、`marketing_capability_list`、`analysis_graph_get`、`analysis_graph_expand`、`analysis_graph_fork`、`metric_compute`、`professional_analytics_compute`、`metric_scenario_create`、`metric_monitor_compare` |
| 受控看板与策略 | `dashboard_render`、`dashboard_get`、`dashboard_artifact_get`、`dashboard_drilldown_get`、`strategy_recommendation_generate`、`strategy_task_supplement`、`strategy_task_update`、`strategy_task_reject`、`strategy_task_reorder`、`strategy_task_get`、`strategy_task_list` |
| 逆向与内容生产 | `benchmark_reverse_create`、`benchmark_reverse_get`、`content_brief_create`、`content_brief_get`、`content_asset_generate`、`content_asset_derive`、`content_asset_get`、`content_artifact_get` |
| 审批、排期与发布 | `approval_record`、`approval_get`、`schedule_create`、`schedule_reschedule`、`schedule_cancel`、`schedule_get`、`publication_submit`、`publication_verify`、`publication_retry`、`publication_get`、`publication_manual_handoff`、`publication_manual_complete`、`delivery_package_get` |
| 效果复盘 | `effect_metric_snapshot_import`、`effect_metric_snapshot_get`、`effect_review_create`、`effect_review_get` |

完整生产 server 共 **71 个公开工具**（原 54 + 新增 17）。

`capability_health_record` 只有在关联证据包含完全匹配的 `toolHealth` 时才能把能力置为 `verified`。健康检查必须由调用方实际完成；能力注册不等于安装、授权、执行或健康验证。`marketing_capability_list` 同样只是声明与路由目录，不会把未安装的 connector 变成可用能力。

## 验证

```bash
npm run typecheck
npm run build
npm test
npm run smoke
```

`npm run smoke` 等价于：

```bash
vitest run tests/e2e/stdio.test.ts tests/e2e/data-research-stdio.test.ts tests/e2e/analysis-stdio.test.ts tests/e2e/public-data-analytics-stdio.test.ts tests/e2e/dashboard-strategy-stdio.test.ts tests/e2e/content-production-stdio.test.ts tests/e2e/data-analytics-documentation.test.ts
```

运行 smoke 前必须构建最新代码。六套 stdio 验收都会 spawn 真正的 `dist/index.js` 并使用官方 MCP stdio client，另有 README/smoke 文档契约，共 **14 个 smoke cases**：

- 原套件覆盖营销链、幂等、血缘、能力健康、输入边界、原始 malformed JSON、协议专用 stdout、启动失败和优雅关闭。
- 数据研究套件启动本地 HTTP fixture 与真 Chromium，完成计划、CSV/XLSX 与质量资产、env-ref 认证临时 API、内容链接、研究权限与限域抓取、竞品确认/Diff、证据读取，并重启验证 plan/session/diff/artifact。loopback 仅在测试进程内显式 allowlist，测试凭据仅通过 env reference 使用。
- 分析网络套件覆盖初始化 instructions、无数据公开研究分支、能力边界、公开/自有文件指标、条件情景、监控、expand/fork、幂等与父图不变，并在重启后仅通过 `analysis_graph_get` 恢复全部节点和引用；验证零分母 unknown、complete-case、公开来源参考度与不可比语义，不使用带外 SQL。
- SQLite/外部分析套件使用临时真实 SQLite 和独立分析 MCP fixture，核对 discover、结构化 snapshot/ingest、engagement/conversion 数值、Wilson 适用性与区间、trend/funnel/anomaly 实质结果、input hash/证据 provenance、fork、重启恢复以及未配置 capability gap；每例使用独立目录和子进程环境，并关闭 server/provider。
- 看板策略套件使用真实 CSV、外部分析 MCP、loopback Chromium 竞对和本地 Playwright Chromium 读取五 SVG，验证双 artifact 分块/hash、下钻、建议数学、任务控制、版本/幂等与重启恢复；不 mock provider、browser 或 artifact。
- 内容生产套件使用显式 allowlist 的 loopback 合法公开页面、真 Chromium、独立 benchmark/media stdio fixture commands 和临时 roots，覆盖两种 brief、三个资产版本、父版本派生、stale conflict、精确幂等重放不增加 provider 调用、32 KiB 多块 SHA-256 读取、公开工具重启恢复以及移除 provider/ffprobe 后的结构化缺口与 NOT_FOUND。测试另用真实 Playwright 解码 1080×1440 PNG，用可信 ffprobe 复核 1080×1920 H.264/AAC MP4 和 2,000 ms 时长（格式解析允许 **50 ms** 容差）；每份 artifact 至少两块，不 mock provider/browser、不跳过 ffprobe、不访问商业服务，并检查 provider/server 进程退出、协议专用 stdout 和无 shutdown stderr。

`npm test` 也包含这些 e2e 文件，因此同样要求最新 `dist`、可用 Chromium 以及上述测试 ffmpeg/ffprobe。

## 当前不支持

- 不做自动因果推断、保证性提升或商业结果承诺；条件情景、Wilson 区间和前后对比不能替代实验或因果分析。
- 看板仅为上述受控 HTML/SVG，不是 Power BI 或专业 BI。内容逆向、生成和 automatic publishing 必须显式配置真实 trusted provider；策略任务仍不自动执行审批、排期、发布或效果复盘。
- 不提供 PostgreSQL、MySQL、GA4 connector，不安装或声明外部营销平台的 OAuth、账户同步、live connector，也不提供定时/自动调度监控；文件、临时授权 API、SQLite 和公开链接快照不等于持续平台集成。
- 不声明内置任何特定专业内容、逆向、媒体或分析 MCP 供应商集成；这些能力必须显式配置真实依赖，未配置时没有本地 reverse/generate/analytics fallback。
- SQLite connector 不支持视图、BLOB、WAL、任意 SQL、实时同步或没有兼容 POSIX `/dev/fd` 的平台。
- 不支持自动登录、CAPTCHA 绕过、文件下载、任意脚本执行、任意 SQL/Python/公式 DSL、跨 Dataset join、语义化竞品结论或把 `unknown` 当作事实。
- 不提供跨工作区访问、多用户认证、远程传输、访问控制、数据库加密或外部 MCP 的 OS 沙箱。

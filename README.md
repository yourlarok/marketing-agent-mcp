# Marketing Agent MCP

通过 stdio 提供营销审计、数据准备、证据资产、受控公开研究和确定性竞品比较的 MCP server。所有实体按 `workspaceId` 隔离；写操作保留审计与幂等记录。

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

Linux 若缺少 Chromium 系统依赖，可按 Playwright 官方提示安装对应依赖。`npm run smoke` 会启动真 Chromium，不会用模拟浏览器替代；缺少浏览器时必须先执行上述安装命令。

启动、构建和测试均应在项目根目录执行。server 入口是构建后的 `dist/index.js`，不是源码或 `node_modules`。

## 数据、导入与证据目录

| 环境变量 | 用途与要求 |
| --- | --- |
| `MARKETING_DATA_DIR` | 必填，必须是已存在目录。SQLite 位于其中的 `marketing.db`。 |
| `MARKETING_IMPORT_ROOT` | 文件导入必填，必须是已存在目录。`ingest_files.paths` 使用相对该目录的路径；绝对路径、`..` 和解析后越界的符号链接均不能绕过目录边界。 |
| `MARKETING_ARTIFACT_DIR` | 产生或读取证据资产时必填。首次使用时自动创建并设为私有目录权限；原始文件/API 响应、规范化 JSONL、质量报告、页面正文和 PNG 截图按 SHA-256 内容寻址保存。 |

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
- 成功结果必须在 `structuredContent` 中提供 `url`、`finalUrl`、`title`、`text`、`fields`、可选 `links` 和有效 PNG 的 `screenshotBase64`。URL origin、字段集合、研究 scope、大小与 PNG 完整性都会再次校验。
- 专业 MCP 的普通不可用/协议失败可回退到 Chromium；访问缺口、scope 拒绝和研究预算边界不会用 fallback 绕过。
- 每次调用结束都会关闭专业 MCP client。server 默认不把任意业务环境变量或凭据转发给该子进程；供应商认证应由其自身受控配置完成。
- 本项目不附带或安装特定供应商的专业 MCP，也不保证任何第三方工具可用。命令配置属于受信任部署配置，不是工具调用方可注入的脚本入口。

## 数据准备与研究流程

所有写工具都需要 `actor`、`requestId` 和 `idempotencyKey`。时间戳使用 UTC ISO-8601。使用 `expectedVersion` / `expectedPlanVersion` 的命令必须传入当前版本；相同幂等键和相同输入可安全重放，不同输入会被拒绝。

### 1. 计划、文件和质量报告

1. 用 `workspace_create` 创建工作区。
2. 用 `data_request_plan` 声明目标、`questionTypes` 与当前 `availableFields`，得到第 1 轮计划。
3. 用 `ingest_files` 导入 CSV/XLSX；关联计划时同时传 `planId` 和当前 `expectedPlanVersion`。一次可传多个路径，XLSX 每个 sheet 形成独立 Dataset/Evidence。
4. 读取 batch 返回的 `datasetIds` / `evidenceIds`。每个数据集保存原始资产、规范化 JSONL 和质量报告；质量统计与 issue 包括行列数、重复/空行、类型不一致、重复/空表头、列数不一致和缺失公式缓存值。
5. 成功导入会推进计划轮次并合并字段。无法回答的问题继续显式列出缺失字段；用 `data_request_decline` 拒绝某一轮时必须给出限制原因。

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
4. 查看 `state`、`stopReason`、`gaps`、`frontier`、`visitedUrls`、`attemptCount`、`candidateBytes` 与 `elapsedMs`。运行时 limits 只能调低，不能超过 session 已配置上限。

完成的研究 session 不能随意重跑；等待权限的 seed-only 部分结果可在授权后继续保留的 frontier。

### 5. 血缘、重启与证据读取

`data_research_get` 可读取 `data_request_plan`、`ingestion_batch`、`research_session`、`competitor`、`competitor_diff` 的工作区血缘与审计 request ID。原 `lineage_get` 继续读取营销任务链。

`evidence_asset_get` 只接受 `workspaceId`、`evidenceId`、`assetId`，返回资产元数据及 base64 `content`，不接受文件路径。Evidence 的 `assets` 元数据提供 asset ID 与 kind。

SQLite、实体版本、审计和幂等结果在同一数据目录重启后保留；artifact 通过内容哈希重新读取。`data_research_get` 不返回整个实体 payload，需结合命令响应与资产读取获取业务内容。

## 上限、部分失败与隐私

### 内置上限

调用方可设置更小的合法限制，不能通过请求抬高硬上限。

| 范围 | 上限 |
| --- | --- |
| MCP 输入 | 完整序列化参数 64 KiB；集合通常最多 1,000 项；严格字段与嵌套秘密字段名检查 |
| 文件/API 表格导入 | 单文件 25 MiB、100 文件、批次 100,000 行、500 列 |
| 规范化数据 | 单 Dataset JSONL 25 MiB；单批 JSONL 100 MiB |
| XLSX 解压 | 单 entry 64 MiB；workbook 合计 128 MiB |
| 临时 API HTTP | 响应 10 MiB；请求超时 10 秒；最多 5 次重定向 |
| 内容链接 | 每批 100 个；每页最多 50 个 CSS 字段 |
| Chromium/MCP 采集 | 单次默认/最大 15 秒；PNG 截图最多 10 MiB |
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

每次内容采集结束会关闭 Chromium、目标固定代理和专业 MCP client。server 响应 `SIGINT` / `SIGTERM`，关闭 MCP transport 和 SQLite 后退出；关闭 MCP client 也会触发 transport 清理。不要在写入或关闭过程中直接删除数据库或证据目录。

## 工具总览

| 类别 | 工具 |
| --- | --- |
| 工作区与营销血缘 | `workspace_create`、`source_register`、`dataset_register`、`evidence_record`、`finding_record`、`recommendation_create`、`task_create`、`task_transition`、`lineage_get` |
| 外部能力元数据 | `capability_register`、`capability_health_record`、`capability_list` |
| 数据计划与导入 | `data_request_plan`、`data_request_decline`、`ingest_files`、`ingest_temporary_api`、`ingest_content_links` |
| 公开研究 | `research_session_create`、`research_permission_set`、`research_session_run` |
| 竞品与证据 | `competitor_confirm`、`competitor_diff_create`、`data_research_get`、`evidence_asset_get` |

`capability_health_record` 只有在关联证据包含完全匹配的 `toolHealth` 时才能把能力置为 `verified`。健康检查必须由调用方实际完成；能力注册不等于安装、授权、执行或健康验证。

## 验证

```bash
npm run typecheck
npm run build
npm test
npm run smoke
```

`npm run smoke` 等价于：

```bash
vitest run tests/e2e/stdio.test.ts tests/e2e/data-research-stdio.test.ts
```

运行 smoke 前必须构建最新代码。两套验收都会 spawn 真正的 `dist/index.js` 并使用官方 MCP stdio client：

- 原套件覆盖营销链、幂等、血缘、能力健康、输入边界、原始 malformed JSON、协议专用 stdout、启动失败和优雅关闭。
- 数据研究套件启动本地 HTTP fixture 与真 Chromium，完成计划、CSV/XLSX 与质量资产、env-ref 认证临时 API、内容链接、研究权限与限域抓取、竞品确认/Diff、证据读取，并重启验证 plan/session/diff/artifact。loopback 仅在测试进程内显式 allowlist，测试凭据仅通过 env reference 使用。

`npm test` 也包含这些 e2e 文件，因此同样要求最新 `dist` 和可用 Chromium。

## 当前不支持

- 不提供分析引擎、仪表盘、内容生成、审批执行、发布或效果衡量。
- 不声明内置任何外部营销平台或专业 MCP 供应商集成。
- 不支持自动登录、CAPTCHA 绕过、文件下载、任意脚本执行、语义化竞品结论或把 `unknown` 当作事实。
- 不提供跨工作区访问、多用户认证、远程传输、访问控制或数据库加密。

# Marketing Agent MCP

一个通过 stdio 提供营销审计、血缘和受控能力元数据的 MCP server。当前阶段只保存结构化记录，不主动访问外部营销平台。

## 环境要求与安装

- Node.js **22.23.1 或更高版本**（使用内置 `node:sqlite`）。
- npm。

```bash
npm ci
npm run build
mkdir -p /absolute/path/to/marketing-data
```

`MARKETING_DATA_DIR` 必须指向一个**已经存在的目录**。server 不会自动创建该目录。启动、构建和 smoke 测试均应在项目根目录执行。

## MCP 客户端注册

先构建，再把下面配置合并到 MCP 客户端的 server 配置中。将两个路径替换为本机绝对路径；不要把 `node_modules` 或源码入口当作启动目标。

```json
{
  "mcpServers": {
    "marketing-agent": {
      "command": "node",
      "args": [
        "/absolute/path/to/marketing-agent-mcp/dist/index.js"
      ],
      "env": {
        "MARKETING_DATA_DIR": "/absolute/path/to/marketing-data"
      }
    }
  }
}
```

如客户端配置要求提供其他供应商秘密，只使用占位符或客户端的安全引用机制，例如 `"apiKey": "<YOUR_API_KEY>"`。本阶段 server 不读取或使用该示例秘密，也不要把真实凭据写入仓库、工具参数或证据定位符。

手动诊断启动命令：

```bash
MARKETING_DATA_DIR=/absolute/path/to/marketing-data node dist/index.js
```

该进程通过 stdio 通信，不是 HTTP 服务，也不提供浏览器端口。stdout 仅承载 MCP/JSON-RPC 协议；诊断信息写 stderr。缺少或传入无效数据目录时，进程在 stderr 报告原因并以非零状态退出。

## 工具

所有写工具都需要 `actor`、`requestId` 和 `idempotencyKey`。时间戳使用 UTC ISO-8601；实体按 `workspaceId` 隔离。

| 工具 | 用途 |
| --- | --- |
| `workspace_create` | 创建可审计工作区 |
| `source_register` | 注册数据来源及所有权边界 |
| `dataset_register` | 注册数据集、覆盖范围和限制 |
| `evidence_record` | 保存证据元数据、哈希及可选结构化 `toolHealth` |
| `finding_record` | 记录 fact、inference 或 unknown，并保留事实边界 |
| `recommendation_create` | 创建由 finding 支持的建议 |
| `task_create` | 创建由 recommendation 支持的草稿任务 |
| `task_transition` | 在状态和依赖检查下推进任务 |
| `lineage_get` | 读取工作区内的实体血缘和审计 request ID |
| `capability_register` | 注册用户扩展能力元数据，不安装或执行能力 |
| `capability_health_record` | 记录外部健康检查结果 |
| `capability_list` | 按工作区、适配器类型或状态列出能力 |

`capability_health_record` 只有在关联证据包含匹配的 `toolHealth`（目的、capability ID、健康状态、检查时间和版本完全一致）时，才能把能力置为 `verified`。健康检查必须由调用方在 server 外实际完成；server 不会仅凭声明认定工具健康。

## 持久化与生命周期

数据库位于 `${MARKETING_DATA_DIR}/marketing.db`。实体、审计记录和幂等结果写入同一 SQLite 数据库；使用同一数据目录重启后，可继续读取血缘和能力，并用原命令上下文安全重放已完成命令。

备份时应备份整个数据库文件，并避免在写入期间复制出不一致的快照。删除数据目录会永久删除本地记录。

server 响应 `SIGINT` 和 `SIGTERM`，关闭 MCP transport 和 SQLite 后以状态 0 退出。关闭 MCP 客户端或终止进程前，不要直接删除数据库。启动失败会写 stderr 并返回非零状态。

## 安全边界

- stdout 只用于协议消息，不能加入启动横幅或普通日志。
- malformed tool input 返回安全的 MCP 错误；内部异常不会把堆栈或底层错误细节作为工具结果返回。
- 输入限制包括 64 KiB 序列化上限、集合数量限制、严格字段和嵌套秘密字段名检查。
- 不接受包含 URL 嵌入凭据或秘密查询参数的证据定位符；不要尝试绕过这些检查。
- 能力注册只保存受控元数据，不执行适配器、脚本或连接器。
- 数据库文件包含业务记录，应按敏感数据设置文件权限、备份和保留策略。

## 验证

真实验收会 spawn 构建后的 `dist/index.js`，使用官方 MCP SDK stdio client 完成完整营销链、幂等重放、血缘、能力注册与健康验证，并在同一数据库上重启验证读取；另有原始 stdio 进程检查 malformed JSON、协议专用 stdout、启动失败和优雅关闭。

```bash
npm run typecheck
npm run build
npm test
npm run smoke
```

`npm run smoke` 等价于 `vitest run tests/e2e/stdio.test.ts`，运行前必须先构建最新代码。`npm test` 也包含该验收文件，因此同样要求 `dist` 是当前构建产物。

## 本阶段限制

- 不执行外部数据摄取、远程研究或证据正文抓取；只登记调用方提供的元数据。
- 不提供分析引擎、仪表盘、内容生成、审批流、发布或效果衡量。
- 不声明任何外部营销平台集成。
- 能力注册不等同于安装、授权、执行或健康验证。
- 不提供多用户认证、网络传输、远程访问控制或数据库加密；这些边界需要在部署环境中另行处理。

# 智能营销分析网络 Task 1 报告

## 范围与根因/设计

BASE `69ee3626093c3d1907ae89612d2c7a1ff1039254` 没有分析图、受控指标计算、参考度或条件情景契约。此次只新增纯领域层，不修改 SQLite、application service、MCP、migration 或依赖。

设计原则：

- 图使用调用方提供的非空稳定 ID；节点 kind 受控，边有向且引用必须存在；拒绝重复节点 ID、边 ID、重复有向关系、孤儿引用及任意环。
- 根图版本从 1 开始；expand 校验 expectedVersion，纯函数构造完整候选图并一次性校验，失败不修改输入；可在任意现有节点后扩展。
- fork 深拷贝节点、嵌套 payload、边和 recommendedActions，记录 immediate parentGraphId/parentVersion/forkNodeId，父图不变。
- 指标只能按 catalog ID 计算，调用方不能传公式。complete-case 要求同一行两个字段均为有限非负 number；缺失、类型错误、负数、NaN、Infinity 都排除，绝不补 0。
- 求和采用 Neumaier 补偿求和，声明 `ieee754_compensated_sum`，不做显示舍入。零分母、无有效行和有限输入求和溢出均返回 unknown/null，不输出 0 冒充 unknown，也不持久化 Infinity。
- 情景只做“预测分母和其他条件不变”的条件算术；不输出 uplift 概率或保证。0 基线保留 absoluteDelta，relativeDelta=null，原因 `ZERO_BASELINE`。

## 受控 catalog 与精确参考度规则

指标：

- `ctr_v1`：`sum(clicks) / sum(impressions)`，ratio，曝光到点击的过程效率，minimumDenominator=1000。
- `save_like_ratio_v1`：`sum(saves) / sum(likes)`，ratio，互动构成，minimumDenominator=30；明确不是收藏率或转化率。
- 两者均声明分子/分母字段、版本、角色、限制、补偿求和精度，以及 monitoring.requiredFields/minimumDenominator/guardrails/reviewConditions。

`REFERENCE_ASSESSMENT_RUBRIC` 固定降级优先级和 reason 顺序：

1. `NO_VALID_ROWS` / `ZERO_DENOMINATOR` / `NON_FINITE_TOTAL`：unknown。
2. `COMPARABILITY_NOT_COMPARABLE`：low。
3. 统计 sample/stale/exclusions 三类问题：`SAMPLE_BELOW_MINIMUM`、`STALE_DATA`、`EXCLUDED_ROWS`；两类及以上为 low。
4. 恰好一类问题：owned/authorized 为 medium，external_public 为 low。
5. 无上述三类问题：external_public 最高 medium；owned/authorized 只有 comparability=comparable 才为 high。
6. comparability 缺省/未评估始终为 `not_assessed`，输出 `COMPARABILITY_NOT_ASSESSED`，最高 medium。
7. reason 同时包含机器码及简短用户说明；不输出概率、主观百分比或因果置信度。

## 新增接口

`src/domain/analysis-model.ts`：

- 常量/类型：`ANALYSIS_NODE_KINDS`、`SCENARIO_LABELS`、AnalysisGraph/Node/Edge、AnalysisRecommendedAction、MetricScenario 及输入类型。
- `createAnalysisGraph(input)`：创建并校验版本 1 根图。
- `validateAnalysisGraph(graph)`：校验 ID、kind、重复、引用和 DAG。
- `expandAnalysisGraph(graph, input)`：expectedVersion 保护的任意节点原子纯扩展。
- `forkAnalysisGraph(graph, input)`：带 lineage 的深拷贝 fork。
- `createMetricScenario(baseline, input)`：conservative/base/optimistic 条件情景，含绝对/相对变化、预测分子和分子增量、unknown 与 0 基线语义。

`src/domain/metric-catalog.ts`：

- 常量/类型：`METRIC_IDS`、`METRIC_CATALOG`、`REFERENCE_ASSESSMENT_RUBRIC`、reference reason codes、MetricComputation、ReferenceAssessment。
- `getMetricDefinition(metricId)`：受控目录查询。
- `compensatedSum(values)`：补偿求和。
- `computeMetric(metricId, rows)`：complete-case 纯计算及逐行排除原因/样本统计。
- `assessMetricReference(metricId, computation, input)`：确定性五维参考度（provenance/freshness/sample/missingness/comparability）。

## 严格 TDD 记录

### RED（实现文件尚不存在）

命令：

```sh
npx vitest run tests/domain/analysis-model.test.ts tests/domain/metric-catalog.test.ts
```

真实结果：exit 1；`Test Files 2 failed (2)`，`Tests no tests`。两个 suite 分别因无法解析 `src/domain/analysis-model.js` 与 `src/domain/metric-catalog.js` 失败，属于预期 RED。

### GREEN（最小实现后）

同一命令真实结果：exit 0；`Test Files 2 passed (2)`，`Tests 27 passed (27)`，analysis-model 11 项、metric-catalog 16 项。

```sh
npm run typecheck
```

真实结果：exit 0，无 TypeScript 错误。

### 完整测试

首次 `npm test`：397 passed、5 failed；5 项全部来自 stdio e2e，直接错误为缺少 `dist/index.js`。不是领域测试失败。随后按这些 built-stdio 测试的实际前置条件执行：

```sh
npm run build && npm test
```

真实结果：build exit 0；完整测试 exit 0，`Test Files 16 passed (16)`，`Tests 402 passed (402)`。真实 file/HTTP/Chromium/restart stdio 验收也通过。

## 自审与提交

- 仅新增要求的两个领域实现、两个测试和本报告；未增加依赖，未实现 Task 2+。
- DomainError 使用现有 INVALID_INPUT/CONFLICT/NOT_FOUND，strict TypeScript 通过。
- `git diff --check` 在提交前执行并作为最终门禁。
- 计划创建一个本地提交，主题：`feat: add analysis graph and metric domain contracts`；最终 commit hash 以交付时 `git rev-parse HEAD` 为准。

## 风险与后续边界

- minimumDenominator=1000/30 是本版明确、确定性的产品阈值，不是统计显著性保证；后续修改需要版本化定义。
- high 仍只表示数据可参考度，不表示营销结论的因果强度。
- 本任务不读取真实 artifact、不补 Dataset/Evidence 血缘、不持久化 MetricValue，也不做 monitor compare；这些属于后续 Task 4/5。
- 图的 ID 生成、workspace 隔离、审计和幂等由后续应用/持久化层负责；领域层只校验并保留稳定 ID。

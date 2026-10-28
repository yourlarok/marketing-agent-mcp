# Data Analytics Task 4 Report

## Scope and implementation

Base: `47c654e46ae9ad986b80b3910fc5f77891b4d52b`.

Task 1 already supplied the controlled metric catalog, complete-case strict-numeric aggregation, compensated summation, reference rubric, Wilson 95% pure function, and `assessMetricProportion`. Task 2 already supplied CSV/XLSX, Temporary API, and SQLite ingestion into verified `normalized_jsonl` artifacts. This task reused those interfaces without duplicating formulas.

The production change integrates `assessMetricProportion` into the common `AnalysisService` snapshot metric path and writes `proportionAssessment` into the Metric node payload. Consequently:

- `engagement_rate_v1` uses the existing catalog formula `(sum(likes) + sum(saves) + sum(comments)) / sum(impressions)`, with denominator threshold 1000 and no Wilson interval because it is not binomial eligible.
- `conversion_rate_v1` uses `sum(conversions) / sum(clicks)`, with denominator threshold 100. Only owned/authorized data is accepted; `external_public` is rejected.
- `ctr_v1` and eligible conversion computations expose Wilson 95% lower/upper/method/confidence and Bernoulli assumptions only for safe non-negative integer counts, numerator <= denominator, and sufficient samples.
- Non-binomial metrics, unknown computations, non-integer counts, numerator > denominator, and insufficient samples return `not_applicable`, an explicit reason, null interval, and no assumptions.
- Wilson assumptions explicitly limit interpretation to IID Bernoulli sampling uncertainty, not marketing-lift probability or a causal interval.
- The metric capability list now names all four implemented controlled metric IDs. No connector or analytics MCP registration was added.

## TDD evidence

### RED

Command:

```sh
npm test -- --run tests/application/analysis-snapshot-proportion-service.test.ts
```

Before the production edit: **13 tests, 12 failed and 1 passed**. Four real-snapshot tests and all proportion boundary/complete-case tests failed because Metric payloads had no `proportionAssessment`; the capability test failed because it omitted the two new metric IDs. The already-implemented public-conversion rejection test passed, confirming that existing guardrail remained intact.

Representative failure:

```text
AssertionError: expected { …(28) } to match object ...
- "proportionAssessment": {
-   "status": "not_applicable",
-   "reason": "METRIC_NOT_BINOMIAL_ELIGIBLE",
...
```

### GREEN

After integrating the existing proportion assessment into `readMetric`/`metricPayload` and updating capability metadata:

```sh
npm test -- --run tests/application/analysis-snapshot-proportion-service.test.ts
```

Result: **1 file passed, 13/13 tests passed**.

## Acceptance coverage

`tests/application/analysis-snapshot-proportion-service.test.ts` drives `AnalysisService.computeMetric` against actual ingested snapshots, not direct row-array computation:

- CSV and XLSX file ingestion.
- Temporary API JSON ingestion through a real loopback HTTP server and `SafeHttpClient`.
- SQLite ingestion through a real temporary database and `SqliteConnector`.
- For each source type: engagement numerator/denominator/value and non-applicability; conversion value, reference threshold, and Wilson interval; CTR Wilson compatibility.
- Public conversion rejection while public engagement remains computable.
- Wilson IID Bernoulli and non-causal assumptions.
- Non-integer, negative, numerator > denominator, below-minimum, missing, and zero-denominator cases.
- Strict decimal/scientific normalization, complete-case exclusions, compensated-sum contract, sample sufficiency, excluded-row reference downgrade, and interval/reference consistency.

Existing domain tests continue to verify published Wilson values and formula-level edge cases.

## Files changed

- `src/application/analysis-service.ts`: call and persist the existing proportion assessment; advertise all controlled metric IDs.
- `tests/application/analysis-snapshot-proportion-service.test.ts`: new real-snapshot service acceptance and boundary tests.
- `plans/data-analytics-task-4-report.md`: this report.

No catalog, proportion formula, ingest connector, MCP registration, or analytics provider code was changed.

## Final verification

Commands and results:

- `npm run typecheck`: passed (`tsc -p tsconfig.json --noEmit`).
- `npm run build`: passed (`tsc -p tsconfig.json`).
- `npm test`: final run passed, **30 test files and 637/637 tests**.
- `git diff --check 47c654e46ae9ad986b80b3910fc5f77891b4d52b`: passed, no whitespace errors.
- Final staged diff/status reviewed before commit; only the three Task 4 files above were included.

One intermediate full-suite run had a single unrelated Chromium acquisition failure for HTTP 429 (`acquisition_failed` instead of `http_429`), with 636 other tests passing. The isolated test passed on rerun, and the subsequent complete `npm test` passed all 637 tests, so no production workaround was added.

## Self-review and concerns

- The implementation is deliberately confined to the common verified-artifact metric path, so all four ingest types share the same applicability rules and cannot drift.
- Existing reference behavior and metric/scenario/monitor result shapes remain compatible; this adds a payload field rather than changing existing values.
- No known task-scope issue remains. The transient Chromium 429 result is worth watching as possible timing sensitivity, but it is outside this change and passed final verification.

# Marketing Data Preparation and External Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real file/API/link ingestion, guided data preparation, permission-bounded browsing, evidence assets, competitor confirmation, and deterministic competitor Diff to the existing MCP server.

**Architecture:** A separate `DataResearchService` owns new use cases while reusing the existing command pipeline, workspace rules, evidence model, and SQLite repositories. File/network/browser I/O happens outside database transactions; each command atomically persists its resulting batch, sources, datasets, evidence, audit, and idempotency record. Playwright and startup-configured professional MCP acquisition sit behind one router; no arbitrary crawler or connector command is accepted.

**Tech Stack:** Existing Node.js 22.23.1+, TypeScript strict/NodeNext, MCP SDK, Zod, `node:sqlite`, Vitest; add `exceljs@4.4.0`, `csv-parse@7.x`, `undici`, and `playwright` with lockfile-pinned transitive versions.

**Spec:** `/Users/zhangyang694/docs/superpowers/specs/2026-10-26-marketing-agent-mcp-design.md`

## Global Constraints

- Work in `/Users/zhangyang694/marketing-agent-mcp` on a new `feat/data-research` branch created from `main` during execution.
- Preserve existing tool signatures and constructor callers: `createMcpServer(service, dataResearch?)` uses an optional second argument.
- All writes reuse `AuditableCommandPipeline`; all references are workspace-scoped; no service retains transaction repositories.
- Never modify `001_initial.sql`; add ordered `002_data_research.sql` and upgrade a real stage-1 database in tests.
- I/O never holds a SQLite write transaction. A failed batch leaves no half-written database graph; completed public observations remain `external_observation`.
- Public data cannot answer owned conversion questions. No authentication bypass, CAPTCHA bypass, access-control bypass, arbitrary script, or arbitrary tool command.
- Secrets and credential values never enter domain input, Evidence, audit, logs, MCP errors, browser pages, or redirected requests. Only controlled credential references are accepted.
- Fixed ceilings: file 25 MiB each, 100 files/batch, 100,000 rows and 500 columns/dataset; HTTP 10 MiB and 10 seconds/request; research at most 20 pages, depth 2, 60 seconds, and 20 MiB. Callers may only lower research ceilings.
- Default network policy denies private/loopback/link-local destinations. Local tests use explicit per-process allowlists; every redirect and browser subrequest is checked.
- `.xls`, macros, formula execution, external workbook links, BI, publishing, and causal attribution are outside this stage.

## File Structure

```text
migrations/002_data_research.sql
src/domain/{data-research-model.ts,data-preparation.ts,competitor-diff.ts}
src/application/{data-research-commands.ts,data-research-service.ts}
src/infrastructure/{artifact-store.ts,file-ingestor.ts,safe-http.ts,playwright-acquisition.ts,mcp-acquisition.ts,acquisition-router.ts}
src/mcp/register-data-research-tools.ts
tests/domain/{data-preparation.test.ts,competitor-diff.test.ts}
tests/application/data-research-service.test.ts
tests/infrastructure/{artifact-store.test.ts,file-ingestor.test.ts,safe-http.test.ts,acquisition.test.ts}
tests/mcp/data-research-tools.test.ts
tests/e2e/data-research-stdio.test.ts
tests/fixtures/{csv,xlsx,http-site}/...
```

Modify only the integration points in `config.ts`, `index.ts`, `domain/model.ts`, `application/ports.ts`, `application/commands.ts`, `infrastructure/sqlite.ts`, `infrastructure/sqlite-store.ts`, `application/marketing-service.ts`, `mcp/server.ts`, `mcp/schemas.ts`, `mcp/register-tools.ts`, and `README.md`.

## Review Focus

- Symlink/path escape and decompression bombs: importing must reject files outside the configured root and stop at decompressed row/column/byte limits; Tasks 2 and 4 pin these tests.
- SSRF, DNS changes, redirect credential leakage, and unbounded responses: every connection/redirect is revalidated and authorization is never forwarded across origins; Task 5 pins real HTTP tests.
- Expansion without permission or out-of-scope links: no request is made beyond approved seeds; Task 7 pins request logs, denial, host/path, cycle, and stop-limit tests.
- Partial file/page failure: successful items keep evidence, failures become explicit gaps, and no item is reported complete falsely; Tasks 4, 6, and 7 pin partial-batch/session tests.
- Unconfirmed or cross-workspace competitor evidence: Diff refuses it and missing dimensions become `unknown`, not inferred values; Task 8 pins these tests.

---

### Task 1: Versioned Data-Research Storage

**Files:**
- Create: `migrations/002_data_research.sql`, `src/domain/data-research-model.ts`, `tests/application/data-research-service.test.ts`
- Modify: `src/application/ports.ts`, `src/infrastructure/sqlite.ts`, `src/infrastructure/sqlite-store.ts`, `src/application/marketing-service.ts`

**Interfaces:**
- Produces entities `DataRequestPlan`, `IngestionBatch`, `ResearchSession`, `Competitor`, `CompetitorDiff` with normal entity/version fields and typed repositories.
- Produces ordered batch/source/dataset/evidence, research/evidence, competitor/evidence, and diff/finding references with composite workspace foreign keys.

- [ ] **Step 1: Write failing migration/repository tests**
  Create a stage-1-only database, open it with current code, and assert 002 upgrades it. Test repeat open, entity round trips, optimistic versions, ordered references, cross-workspace rejection, and rollback. Add lineage cases for the new roots.

- [ ] **Step 2: Run tests and verify red**
  Run: `npm run test -- tests/application/data-research-service.test.ts`
  Expected: FAIL because 002, models, and repositories do not exist.

- [ ] **Step 3: Implement ordered migration and persistence**
  Add migration version tracking that applies pending migrations once, rejects a database newer than the program, and remains atomic. Do not edit 001. Extend lineage through declared new references with the existing 1,000-node limit.

- [ ] **Step 4: Verify storage and regressions**
  Run: `npm run typecheck && npm run test -- tests/application/data-research-service.test.ts tests/infrastructure/sqlite-store.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add migrations src tests && git commit -m "feat: add data research persistence"
  ```

### Task 2: Real CSV/XLSX Parsing

**Files:**
- Create: `src/infrastructure/file-ingestor.ts`, `tests/infrastructure/file-ingestor.test.ts`, `tests/fixtures/csv/*`, `tests/fixtures/xlsx/*`
- Modify: `package.json`, `package-lock.json`, `src/config.ts`

**Interfaces:**
- Produces `ingestFiles(paths: string[], limits: IngestLimits): Promise<ParsedFileBatch>`; each parsed dataset contains source metadata, fields, JSONL rows, quality statistics, and nonfatal issues.
- `MARKETING_IMPORT_ROOT` is required for file imports; only regular `.csv`/`.xlsx` files inside it are accepted.

- [ ] **Step 1: Write failing parser/security tests**
  Generate real CSV and multi-sheet XLSX fixtures. Cover BOM, quoted delimiters, duplicate/empty headers, invalid UTF-8, inconsistent columns, formulas using cached results, duplicate rows, type inconsistencies, multiple files, the 100-file batch ceiling, encrypted files, path traversal, symlink escape, non-regular files, and row/column/byte termination.

- [ ] **Step 2: Run parser tests and verify red**
  Run: `npm run test -- tests/infrastructure/file-ingestor.test.ts`
  Expected: FAIL because the ingestor is absent.

- [ ] **Step 3: Implement bounded real parsing**
  Use streaming `csv-parse` and `exceljs` readers. Canonicalize paths before reading and again after symlink resolution. Do not execute formulas/macros/links; do not silently accept partial truncated datasets.

- [ ] **Step 4: Verify parser behavior**
  Run: `npm run typecheck && npm run test -- tests/infrastructure/file-ingestor.test.ts`
  Expected: PASS with real XLSX/CSV files, not text masquerading as workbooks.

- [ ] **Step 5: Commit**
  ```bash
  git add package*.json src tests && git commit -m "feat: parse bounded CSV and XLSX imports"
  ```

### Task 3: Quality Reports and Guided Data Rounds

**Files:**
- Create: `src/domain/data-preparation.ts`, `src/application/data-research-commands.ts`, `src/application/data-research-service.ts`, `tests/domain/data-preparation.test.ts`
- Modify: `src/application/data-research-commands.ts`, `tests/application/data-research-service.test.ts`

**Interfaces:**
- Produces `planDataRequests(Command<CreateDataRequestPlan>): Promise<DataRequestPlan>` and `declineDataRound(Command<DeclineDataRound>): Promise<DataRequestPlan>`.
- Question types: `content_performance | lead_funnel | conversion | competitor_content`; plan states: `awaiting_data | ready | partial | blocked`.

- [ ] **Step 1: Write failing question/quality tests**
  Assert the first round asks only for current missing data, content questions do not demand orders, conversion never accepts engagement fields, quality reports expose missing/duplicate/type/format/freshness issues, and declining a round reduces answerable scope with explicit limitations.

- [ ] **Step 2: Run domain tests and verify red**
  Run: `npm run test -- tests/domain/data-preparation.test.ts tests/application/data-research-service.test.ts`
  Expected: FAIL on missing planner and service methods.

- [ ] **Step 3: Implement deterministic planning**
  Define a fixed question-to-field catalog and round transitions. No LLM call is required for the deterministic first version. Persist plans through the audited command pipeline and support `planId + expectedPlanVersion` for later imports.

- [ ] **Step 4: Verify planning and quality**
  Run: `npm run typecheck && npm run test -- tests/domain/data-preparation.test.ts tests/application/data-research-service.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src tests && git commit -m "feat: guide minimum necessary data collection"
  ```

### Task 4: Atomic Import Batches and Evidence Assets

**Files:**
- Create: `src/infrastructure/artifact-store.ts`, `tests/infrastructure/artifact-store.test.ts`
- Modify: `src/application/commands.ts`, `src/application/data-research-service.ts`, `src/domain/model.ts`, `src/infrastructure/sqlite-store.ts`, `tests/application/data-research-service.test.ts`

**Interfaces:**
- Produces `importFiles(Command<ImportFiles>): Promise<IngestionBatch>` and `getEvidenceAsset(query: EvidenceAssetQuery): Promise<EvidenceAssetContent>`.
- Produces `AuditableCommandPipeline.executeBatch<T>(...)` for atomic multi-entity writes and server-generated `Evidence.assets`; public `evidence_record` cannot supply assets.
- Batch states: `completed | partial | blocked`; artifact kinds: `original | normalized_jsonl | quality_report | page_text | screenshot | api_response`.

- [ ] **Step 1: Write failing atomicity/asset tests**
  Cover per-file Source, per-CSV/XLSX-sheet Dataset/Evidence, exact replay, partial file failure, injected database failure with no half graph, content hash/length, workspace-only reads, path-like asset IDs, and file permission checks.

- [ ] **Step 2: Run tests and verify red**
  Run: `npm run test -- tests/infrastructure/artifact-store.test.ts tests/application/data-research-service.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement content-addressed artifacts and batch writes**
  Store artifacts beneath `MARKETING_ARTIFACT_DIR` using SHA-256 names, atomic creation, `0600` files/`0700` directories. Perform parsing before the transaction; never delete an existing referenced artifact during rollback. Asset reads accept only workspace/evidence/asset IDs.

- [ ] **Step 4: Verify atomic import**
  Run: `npm run typecheck && npm run test -- tests/infrastructure/artifact-store.test.ts tests/application/data-research-service.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src tests && git commit -m "feat: persist atomic imports and evidence assets"
  ```

### Task 5: Temporary API over Safe Real HTTP

**Files:**
- Create: `src/infrastructure/safe-http.ts`, `tests/infrastructure/safe-http.test.ts`
- Modify: `src/application/data-research-service.ts`, `src/config.ts`, `tests/application/data-research-service.test.ts`

**Interfaces:**
- Produces `ingestTemporaryApi(Command<IngestTemporaryApi>): Promise<IngestionBatch>`.
- Requests are GET-only, `owned | authorized`, with `expiresAt` and optional `credentialRef: "env:<ALLOWED_NAME>"`; only the HTTP layer resolves the environment value.

- [ ] **Step 1: Write failing real HTTP tests**
  With `node:http`, cover JSON/CSV responses, bearer injection, expiry, unknown ref, plaintext credential rejection, 401/403/429, timeout, oversized/chunked responses, redirects, cross-origin auth stripping, `file://`, userinfo, private/link-local targets, DNS changes, and no secret in database/errors.

- [ ] **Step 2: Run HTTP tests and verify red**
  Run: `npm run test -- tests/infrastructure/safe-http.test.ts`
  Expected: FAIL because safe HTTP is absent.

- [ ] **Step 3: Implement bounded HTTP and API ingestion**
  Use Undici with explicit redirect handling and destination validation at every hop. Local test hosts require an explicit allowlist. Persist API response artifacts and quality results using Task 4 batch semantics.

- [ ] **Step 4: Verify HTTP and ingestion**
  Run: `npm run typecheck && npm run test -- tests/infrastructure/safe-http.test.ts tests/application/data-research-service.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add package*.json src tests && git commit -m "feat: ingest temporary APIs through safe HTTP"
  ```

### Task 6: Content Links and Professional Acquisition Routing

**Files:**
- Create: `src/infrastructure/{playwright-acquisition.ts,mcp-acquisition.ts,acquisition-router.ts}`, `tests/infrastructure/acquisition.test.ts`, `tests/fixtures/http-site/*`
- Modify: `src/application/data-research-service.ts`, `src/config.ts`, `package.json`, `package-lock.json`

**Interfaces:**
- Produces `AcquisitionProvider.acquire(request: AcquireRequest): Promise<AcquiredPage>` and `ingestContentLinks(Command<IngestContentLinks>): Promise<IngestionBatch>`.
- Router order: verified startup-configured professional MCP provider → Playwright → explicit `CAPABILITY_UNAVAILABLE`.

- [ ] **Step 1: Write failing dynamic-page/router tests**
  Serve a local page requiring client-side rendering. Assert real Chromium text, structured CSS-selector fields and screenshot assets; exercise provider health and priority with a real local MCP fixture. Cover 401/403/429, login/CAPTCHA markers, browser crash, screenshot failure, downloads, subrequest denial, and partial batches.

- [ ] **Step 2: Run acquisition tests and verify red**
  Run: `npx playwright install chromium && npm run test -- tests/infrastructure/acquisition.test.ts`
  Expected: FAIL because providers/router are absent.

- [ ] **Step 3: Implement real acquisition**
  Use isolated browser contexts without persistent cookies; disable downloads and validate subrequests. Startup configuration alone does not mark MCP verified: perform a real fixture acquisition. Never execute caller-provided scripts or arbitrary selector JavaScript.

- [ ] **Step 4: Verify acquisition and persistence**
  Run: `npm run typecheck && npm run test -- tests/infrastructure/acquisition.test.ts tests/application/data-research-service.test.ts`
  Expected: PASS with actual rendered content and image bytes.

- [ ] **Step 5: Commit**
  ```bash
  git add package*.json src tests && git commit -m "feat: acquire content through professional browser tools"
  ```

### Task 7: Permission-Bounded Research Sessions

**Files:**
- Modify: `src/application/data-research-service.ts`, `src/domain/data-research-model.ts`, `tests/application/data-research-service.test.ts`, `tests/infrastructure/acquisition.test.ts`

**Interfaces:**
- Produces `createResearchSession`, `setResearchPermission`, and `runResearch`, each accepting `Command<...>` and returning `ResearchSession`.
- Expansion: `not_requested | awaiting_permission | allowed | denied`; states: `awaiting_permission | ready | completed | partial | blocked`.

- [ ] **Step 1: Write failing permission/crawl tests**
  Use a local multi-page site with cycles and off-scope links. Assert no unapproved expansion request occurs, denial processes seeds only, host/path/depth/page/time/byte ceilings hold, duplicate URLs are canonicalized, lower caller limits win, higher limits are rejected, and single-page failure preserves partial evidence.

- [ ] **Step 2: Run research tests and verify red**
  Run: `npm run test -- tests/application/data-research-service.test.ts tests/infrastructure/acquisition.test.ts`
  Expected: FAIL on session methods.

- [ ] **Step 3: Implement bounded research orchestration**
  Persist goal/scope/stop policy before acquisition, recheck permission in the same command, use the acquisition router, record stop reason/gaps, and atomically persist each completed session result without retaining browser state.

- [ ] **Step 4: Verify research boundaries**
  Run: `npm run typecheck && npm run test -- tests/application/data-research-service.test.ts tests/infrastructure/acquisition.test.ts`
  Expected: PASS; server request logs prove no out-of-scope access.

- [ ] **Step 5: Commit**
  ```bash
  git add src tests && git commit -m "feat: run permission bounded research sessions"
  ```

### Task 8: Confirmed Competitors and Deterministic Diff

**Files:**
- Create: `src/domain/competitor-diff.ts`, `tests/domain/competitor-diff.test.ts`
- Modify: `src/application/data-research-service.ts`, `tests/application/data-research-service.test.ts`

**Interfaces:**
- Produces `confirmCompetitor(Command<ConfirmCompetitor>): Promise<Competitor>` and `diffCompetitors(Command<CreateCompetitorDiff>): Promise<CompetitorDiff>`.
- Competitor status `confirmed | excluded`; Diff entry result `same | different | unknown` with ordered evidence IDs.

- [ ] **Step 1: Write failing confirmation/diff tests**
  Cover unconfirmed/excluded/cross-workspace competitors, duplicate evidence, missing dimensions, same/different/unknown values, stable order, and attempts to derive owned conversion from external observations.

- [ ] **Step 2: Run Diff tests and verify red**
  Run: `npm run test -- tests/domain/competitor-diff.test.ts tests/application/data-research-service.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement confirmation and pure comparison**
  Only structured observations acquired by research/content ingestion feed Diff. Missing is unknown; no effect or causal verdict. Optional semantic conclusions use existing Finding `inference` with evidence and limitations.

- [ ] **Step 4: Verify Diff**
  Run: `npm run typecheck && npm run test -- tests/domain/competitor-diff.test.ts tests/application/data-research-service.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src tests && git commit -m "feat: compare confirmed competitors with evidence"
  ```

### Task 9: MCP Contracts for Data Research

**Files:**
- Create: `src/mcp/register-data-research-tools.ts`, `tests/mcp/data-research-tools.test.ts`
- Modify: `src/mcp/{server.ts,schemas.ts,register-tools.ts}`, `src/index.ts`

**Interfaces:**
- Produces tools `data_request_plan`, `data_request_decline`, `ingest_files`, `ingest_temporary_api`, `ingest_content_links`, `research_session_create`, `research_permission_set`, `research_session_run`, `competitor_confirm`, `competitor_diff_create`, `data_research_get`, `evidence_asset_get`.

- [ ] **Step 1: Write failing linked-transport contract tests**
  Cover every tool, strict schemas, full-argument 64 KiB limit, safe errors, secret-like fields, expired API, cross-workspace reads, path-free asset access, and all prior tool contracts.

- [ ] **Step 2: Run MCP tests and verify red**
  Run: `npm run test -- tests/mcp/data-research-tools.test.ts tests/mcp/tools.test.ts`
  Expected: FAIL on unregistered tools.

- [ ] **Step 3: Register thin adapters and startup wiring**
  Reuse the existing `validateToolArguments` and error mapper. No business rules or direct repository access in MCP modules; optional service preserves old construction patterns.

- [ ] **Step 4: Verify protocol contracts**
  Run: `npm run typecheck && npm run test -- tests/mcp/data-research-tools.test.ts tests/mcp/tools.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src tests && git commit -m "feat: expose data research workflows over MCP"
  ```

### Task 10: Full Built-Process Acceptance and Operations Guide

**Files:**
- Create: `tests/e2e/data-research-stdio.test.ts`
- Modify: `package.json`, `README.md`

**Interfaces:**
- Produces `npm run smoke` running both existing and data-research stdio suites.
- README documents import/artifact roots, allowlists, credential references, Playwright installation, professional MCP acquisition configuration, ceilings, partial failure, privacy, and unsupported behavior.

- [ ] **Step 1: Write failing real-process acceptance**
  Spawn `dist/index.js` with official stdio client and local HTTP/Chromium fixtures. Complete plan → CSV/XLSX batch → quality → temporary API → content links → permission → bounded research → confirmation → Diff → asset read; restart and verify plan/session/diff/artifact persistence.

- [ ] **Step 2: Build and verify initial red**
  Run: `npm run build && npm run test -- tests/e2e/data-research-stdio.test.ts`
  Expected: FAIL until full startup wiring and persisted reads work.

- [ ] **Step 3: Complete acceptance wiring and documentation**
  Ensure test servers use explicit local allowlists, credentials come from test-only environment references, stdout remains protocol-only, and shutdown closes browser/MCP/SQLite resources.

- [ ] **Step 4: Run complete verification**
  Run: `npm run typecheck && npm run build && npm test && npm run smoke`
  Expected: all existing and new tests PASS; both real stdio workflows pass.

- [ ] **Step 5: Commit**
  ```bash
  git add . && git commit -m "test: verify data research workflows end to end"
  ```

## Plan Self-Review Notes

- Spec coverage: implements sections 9.1–9.4, evidence assets, controlled professional acquisition, and the external research portion of the two business channels. Analysis dashboards, strategy execution, publishing, and measurement remain in their approved later stages.
- Type consistency: all new commands use `Command<T>` and `AuditableCommandPipeline`; new roots use existing entity/version/workspace conventions; acquisition returns artifacts consumed by both link ingestion and research sessions.
- Safety: local network access exists only in explicit test/runtime allowlists; credentials are environment references, never values. No tool accepts a script or arbitrary command.
- Proportion: exact boundaries, interfaces, test scenarios, commands, and commits are fixed; implementation bodies remain engineering work.

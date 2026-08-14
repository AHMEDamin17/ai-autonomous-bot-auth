# AGENTS.md - ANONYMOUS_AI

Repository context for coding agents. Last synchronized with the working tree on
2026-08-03.

ANONYMOUS_AI is a full-stack semantic-layer analytics application. Users register
database connections, inspect live schemas, define certified KPIs, and ask natural-
language questions. The backend plans a query, validates it, compiles parameterized
SQL, runs it against the selected live database, evaluates result quality, and
returns data, an answer, a chart recommendation, and a tool trace.

## Source of truth and audit scope

Trust sources in this order:

1. Executable source, package manifests, migrations, and active tests.
2. This file.
3. `README.md`, `AUTONOMOUS_AI_COMPLETE_WORKFLOW.md`, and `CompleteFixes.txt` as
   historical context.

The narrative documents and operational runbooks are tracked source. Keep this
file, `README.md`, `AUTONOMOUS_AI_COMPLETE_WORKFLOW.md`,
`ORCHESTRATOR_MODES.md`, and `CompleteFixes.txt` synchronized with behavior
changes. `CompleteFixes.txt` currently continues through Part 14. There is no
`Plan.txt` in the current tree.

This synchronization reviewed all project-owned source, configuration, migration,
runbook, test, manifest, and documentation files. Generated/vendor/secret content
was intentionally not treated as source: `node_modules/`, `dist/`, `.vite/deps/`,
package lockfiles, binary images, real `.env` files, and the telemetry cache. Never
copy secrets from a real `.env` into documentation, tests, logs, or commits.

## Repository layout

```text
ANONYMOUS_AI/
|-- AGENTS.md
|-- README.md                         # concise setup and current-state overview
|-- CompleteFixes.txt                 # historical changelog
|-- WORKFLOW.md                       # current connection/model flow + next steps
|-- TRACKER.md                        # implementation and verification ledger
|-- AUTONOMOUS_AI_COMPLETE_WORKFLOW.md
|-- generate_project_dump.ps1         # creates ignored source dumps
|-- package.json                      # root command orchestrator
|-- tsconfig.json                     # TS project reference to backend
|-- backend/
|   |-- migrations/001_init.sql       # complete current-schema baseline
|   |-- scripts/migrate.ts and schema/runtime self-test scripts
|   |-- docs/runbooks/
|   |-- src/
|   |-- test/sql-compiler.test.ts      # legacy Jest-style test, not active
|   `-- package.json
`-- frontend/
    |-- e2e/analytics.spec.ts          # Playwright smoke path, needs live services
    |-- public/ and src/assets/
    |-- src/
    |-- Dockerfile                     # static `serve` image on port 5174
    `-- package.json
```

There is no backend Dockerfile and no monorepo framework. The root scripts call the
two workspaces with Windows-oriented `npm.cmd --prefix ...` commands.

## Commands and verification

Run from `ANONYMOUS_AI/` on Windows:

```powershell
npm.cmd run test
npm.cmd run test:implementation
npm.cmd run build
npm.cmd run lint
```

- Root `test` runs the backend tests only.
- Root `build` builds backend, then frontend.
- Root `lint` runs frontend ESLint only; the backend has an ESLint config but no
  package script for it.
- Backend `npm.cmd run test` runs two self-test entry points:
  `src/sql/compiler.ts --selftest` and
  `src/tests/regression.test.ts --selftest`.
- Current expected count is 28 compiler cases plus 96 regression cases.
- Root `test:implementation` runs the fresh-schema, authenticated API,
  semantic-key, vector, model-store/outbox, generator, semantic-model API, and
  configured-schema verification
  self-tests. It requires `autonomous_db`, Qdrant, Ollama, and the local embedding
  model.
- `backend/test/sql-compiler.test.ts` uses Jest syntax, has stale interfaces, and is
  not included by the active test script. Do not assume it runs.
- Frontend `npm.cmd run e2e` invokes Playwright. Its existing scenario expects the
  frontend, backend, metadata MySQL database, and a reachable test connection; the
  Playwright config does not start web servers for it.

Development commands:

```powershell
npm.cmd run dev --prefix backend
npm.cmd run dev --prefix frontend
npm.cmd run migrate --prefix backend
```

The backend defaults to port 3005 and the Vite dev server to 5173. Vite proxies
`/api` to `http://localhost:3005`. Backend `nodemon` watches `src/**/*.ts`, so
changes to `.env` require a manual process restart. Run only one backend process.
An `EADDRINUSE` startup means port 3005 already has a listener; it is unrelated to
frontend authentication.

When changing backend planning, validation, compiler, KPI schema, error handling,
or result behavior, add a case to `backend/src/tests/regression.test.ts` and/or the
compiler self-test. For UI changes, run frontend lint and build. Use Playwright only
when its external prerequisites are available.

## Backend architecture

### Runtime and bootstrap

The backend is strict TypeScript targeting ES2022/CommonJS on Node 18 or newer.
Important entry points:

- `src/main.ts`: loads environment configuration, probes the metadata database up
  to five times, starts the HTTP server even if the probe remains unavailable,
  schedules daily telemetry cleanup, and closes live-adapter pools, catalog pools,
  and the metadata pool on SIGINT/SIGTERM.
- `src/server.ts`: Express application, CORS allowlist, correlation IDs, 1 MB JSON
  and URL-encoded limits, `/api` router, `/healthz`, `/readyz`, 404 handling, and the
  final error handler.
- `src/routes/semanticLayer/analyticsQuery.ts`: one-line compatibility re-export of
  the real analytics router in `src/analytics/query.ts`.

`src/index.ts` no longer exists. Do not recreate or use it as an entry point.

### Three database/pool concerns

Do not confuse these layers:

1. Metadata MySQL: `src/db/connection.ts` exposes a lazy Proxy-wrapped `mysql2`
   pool for `db_connections`, `kpi_metrics`, telemetry, and migration state.
2. Catalog introspection: `src/connections/poolManager.ts` manages MySQL,
   PostgreSQL, MSSQL, and Mongo pools/clients used by schema discovery. Other
   catalog adapters manage their own short-lived clients. Catalog metadata has a
   60-second in-process cache.
3. Analytics execution: `src/analytics/executor/buildLiveAdapter.ts` and
   `adapterPoolRegistry.ts` maintain live SQL adapters keyed by connection identity.
   Adapter `close()` releases the request lease; actual pools are TTL-managed and
   evicted when a connection is deleted or the process shuts down.

Connection deletion clears catalog metadata, evicts both catalog and live pools,
and invalidates `resultCache`. The cache module supports Redis or bounded memory,
but the current analytics query path never calls its `get` or `set`; it is dormant
for reads today.

### Supported connection types

The UI offers MySQL, MariaDB, PostgreSQL, Redshift, SQL Server, SQLite, Snowflake,
BigQuery, Databricks, MongoDB, and Redis. Catalog discovery handles all eleven
(Redis exposes a synthetic `keys` dataset). Natural-language analytics execution is
SQL-only: `query.ts` explicitly rejects MongoDB and Redis before building a live
adapter.

The SQL dialect compiler/live adapters cover MySQL/MariaDB, PostgreSQL/Redshift,
SQL Server, SQLite, Snowflake, BigQuery, and Databricks. SQLite paths are restricted
to `SQLITE_DATA_DIR`. `DB_SSL` and `DB_SSL_REJECT_UNAUTHORIZED` affect supported
MySQL/PostgreSQL paths; MSSQL still uses its own less complete encryption settings.

### Metadata migrations

`scripts/migrate.ts` creates `schema_migrations`, reads `migrations/*.sql`
lexicographically, and records each successful file. It splits SQL naively on `;`,
so do not put semicolons inside migration procedure bodies or string literals.

The current sequence contains only `001_init.sql`. It is a complete fresh-install
baseline that creates all 14 runtime tables directly. Do not reintroduce historical
create-then-alter-then-drop migrations. Future schema changes begin at `002`.

`autonomous_db` is the current metadata database. Use `test:schema` to create and
verify a temporary blank database from the baseline, and `verify:schema` to require
exactly the current runtime table set and the single `001_init.sql` ledger entry.
The old database-copy audit table, combined semantic tables, Summary columns, and
unused KPI `inclusions`/`exclusions` columns must remain absent.

### Authentication, semantic documents, and vectors

- The API-key boundary remains, and all application routes additionally require a
  valid HttpOnly user session after `/api/auth/login`. Mutations use backend-owned
  `req.user`; client-supplied user ID headers are ignored. Connection/model writes
  are admin-only and normal users have read access.
- `LoginGate.jsx` prevents the frontend shell and every application screen from
  rendering until session discovery or login returns an authenticated user.
- `semantic_models` owns one JSON document per connection. Its datasource uses the
  immutable public `semantic_key`, never a bare numeric pointer. MySQL is
  authoritative; Qdrant is a derived, repairable index.
- `src/semanticModels/generator.ts` runs a safe overview pass plus one bounded
  entity pass per selected table, then restores physical identities/types/PKs and
  rebuilds relationships deterministically. Full/append/regenerate/remove scopes
  must remain exact.
- `semantic_vector_outbox` makes Qdrant upsert/delete eventual and durable.
  Collection configuration must remain single-vector 768/Cosine. Local Qdrant and
  Ollama are pinned in the root Compose file and persist in named volumes.
- Generation and vector failures are independent. Never hide or roll back a valid
  MySQL model because Qdrant/Ollama is unavailable.

### Security and resilience

- Every `/api/*` route passes through `requireAuth`. It compares the `x-api-key`
  header with `API_KEY` using `timingSafeEqual`. Only the GET observability SSE
  stream may alternatively use `api_key` in the query string because native
  `EventSource` cannot set a custom header. HTTP logging redacts sensitive query
  values. The dev fallback is `default-dev-key`; production refuses to start
  without `API_KEY`.
- Saved connection secrets use AES-256-GCM. New ciphertext is `enc:v2:` with a
  per-secret salt and PBKDF2-SHA256; `enc:v1:` remains readable. Production throws
  during module load if neither `CONNECTION_SECRET_KEY` nor `APP_SECRET` exists.
- KPI formulas pass `validateSqlExpression`, which blocks statement separators,
  comments, DDL/DML, subqueries, `UNION`, `SLEEP`, and similar unsafe constructs.
- SQL compilation uses identifier allowlists, reserved-word checks, dialect-aware
  quoting/placeholders, parameter caps, and bound values. The LLM never writes or
  edits executable SQL.
- Analytics, Dashboard assistant, and observability routes are rate-limited.
  Redis is optional; without
  `REDIS_URL`, rate limiting and circuit breaking fall back to memory.
- Circuit breaker keys are per connection. The Redis implementation scopes keys by
  `DEPLOYMENT_ID`/environment and falls back to the in-memory implementation if a
  Redis operation fails.

## Analytics request flow

The admin endpoint is `POST /api/analytics/query`, implemented by
`src/analytics/query.ts`. The product endpoint is
`POST /api/assistant/ask`, implemented by `src/routes/assistant.ts`; it resolves
one healthy connection with a ready, schema-valid per-connection semantic model
before execution. Both delegate to
`executeResolvedAnalyticsQuery()` and then the single live execution engine,
`runAnalyticsOrchestrator()` in
`src/analytics/orchestrator/analyticsOrchestrator.ts`.

Dashboard routing must stay upstream of the orchestrator. The LLM receives only
safe connection labels and bounded business context derived from validated
semantic-model names, descriptions, entities, dimensions, and measures. Physical
table/column identifiers are excluded from routing context. A low top score returns
`needs_connection`; a close top-two score returns
`connection_selection_required`; a confident result runs the shared engine.
Only setup-level connection unavailability may fall through to another ranked
candidate. Planner/validator/data-quality failures must not reroute.

Do not search for or restore the removed `runKpiAgentPipeline`,
`runSimplePipelineV2`, `runSimpleAgentPipeline`, `simpleQueryExecutor`, or
`contextBuilder` implementations.

### Request setup

The strict Zod body accepts:

- `question`: 1-2000 characters.
- optional positive `connectionId`.
- optional `conversationId`.
- up to ten structured filters.
- `mode`: `simple | kpi | auto`, default `auto`.
- optional `forcedTableContext`.

Every question now has a mandatory LLM semantic entry. Connectionless greetings,
help, and date/time questions call `planSimpleQuery()` with an empty catalog before
an informational response or connection requirement is returned. Connected catalog
and column/schema questions call the LLM planner first, then a deterministic guard
blocks technical metadata discovery without exposing table, schema, or column
identifiers. Business KPI-list questions remain allowed. There is no local answer
fallback when the configured provider fails.

For an executable request, `query.ts`:

1. Loads and decrypts the selected metadata connection.
2. Loads its KPI rows and calls `buildAiCatalog()`.
3. Rejects MongoDB/Redis and an empty executable catalog.
4. Checks the per-connection circuit breaker.
5. Moves `forcedTableContext` to the front of the catalog without removing other
   tables.
6. Loads the supplied DB-backed conversation only when it is unexpired and belongs
   to the selected connection. Missing, expired, or cross-connection IDs return
   `409 CONVERSATION_UNAVAILABLE`; the frontend creates a replacement and retries.
   Context and successful messages survive restarts in `conversations`/
   `conversation_messages`.
7. Builds a live adapter and invokes the orchestrator.
8. Records successful conversation messages, telemetry, connector metrics, and
   circuit state, then releases the adapter lease with a five-second close bound.

### Orchestrator trust boundary

The orchestrator owns mutable run state and deterministically builds the response.
Its tools are:

```text
query_classifier_tool (deterministic KPI/Simple profile selection, no LLM; first in both modes)
  -> pre_query_guard_tool (backend read-only/date guards, no LLM)
  -> planner_tool (mandatory LLM semantic entry)
  -> validator_tool
  -> sql_compiler_tool
  -> db_execute_tool
  -> result_quality_tool
  -> insight_builder_tool
```

`ANALYTICS_ORCHESTRATOR_MODE` selects who advances the shared tool workflow, not
what order it runs in — both modes run the same eight tools in the same order.
`deterministic` (default) starts at `query_classifier_tool` and follows each tool's
structured `next`, retry, and terminal outcome in backend code with no LLM deciding
order. `planner_tool` is the only tool that invokes the configured LLM;
`query_classifier_tool` is deterministic prompt/profile scoping, not a model call.
`agent` asks a LangGraph ReAct agent to select the tools instead, so its first
action is also an LLM call (choosing to call `query_classifier_tool`). Authoritative
read-only checks, validation, SQL, and final response construction remain
backend-owned in both modes. Invalid values fail with a configuration error instead
of silently selecting a mode.

There is no separate orchestrator-model override. `LLM_PROVIDER` and its
provider-specific model setting select the single model used throughout analytics.
The optional `agent` mode reuses that same configured model for tool selection.

Bounds are controlled by `ANALYTICS_ORCHESTRATOR_MAX_TOOL_CALLS` (18),
`ANALYTICS_PLANNER_MAX_ATTEMPTS` (3), `ANALYTICS_DB_MAX_ATTEMPTS` (2), and
`ANALYTICS_ORCHESTRATOR_RECURSION_LIMIT` (30).

### Classification and mode behavior

`src/routes/semanticLayer/queryClassifier.ts` is deterministic heuristic scoring,
not an LLM call. A KPI score of at least 55 selects the KPI profile; otherwise
normal catalog questions select Simple. It also detects greetings, catalog intent,
ambiguous columns, weak single-word KPI matches, named tables/columns, relative
time filters, and conflicting measures.

Mode semantics are asymmetric in current code:

- `mode: "simple"` forcibly removes a detected KPI and selects Simple.
- `mode: "auto"` uses the classifier.
- `mode: "kpi"` does not force KPI selection; it currently behaves like `auto`
  unless the classifier or later promotion finds a certified KPI.

The main `AnalyticsAssistant.jsx` currently hardcodes `queryMode = "kpi"` while the mode
switch UI is commented out. Do not assume the badge proves the backend executed the
certified-KPI profile; inspect response `mode`, `kpiUsed`, plan, and trace.

`detectConflictingMeasure()` intentionally excludes tokens belonging to configured
dimensions from competing-measure evidence. This prevents namespace fragments such
as `gsc` in `u_gsc_region` from falsely matching unrelated measure columns such as
`u_gsc_amt_qty_1`. An exact competing column named by the user remains strong
evidence and must still reject the wrong KPI.

### Planning profiles and latest certified-KPI routing guard

KPI profile:

- Plain KPI totals and structured KPI questions both call `planKpiQuery()`; there
  is no deterministic KPI-plan bypass.
- The KPI planner receives a compact catalog scoped to the matched KPI.
- Concrete qualifiers introduced by `at`, `for`, or `from ... to ...` also require
  KPI semantic planning so location/dimension/date values cannot be silently
  discarded; `for each <dimension>` remains grouping wording. A deterministic
  post-planner qualifier guard pins concrete `at`/`for` values to a configured
  KPI dimension that semantically matches the KPI name, correcting an unrelated
  planner-selected field or restoring an omitted filter.
- `normalizeMatchedKpiPlan()` pins the certified metric, complete dataset list, and
  complete configured join list, including an intentionally empty join list.
  Saved joins are master joins and cannot be replaced or removed by runtime
  dimension handling.
- The LLM may add only allowed grouping, filter, sort, limit, and time-grain intent;
  it cannot replace the certified formula/tables/joins.
- Named month/year periods (`Nov 2025`, `December -2025`) are parsed
  deterministically onto the KPI’s configured date dimension and passed as
  authoritative user filters, independent of planner output.

Simple profile:

- Explicit single-table/single-column requests such as `what is name from account`
  always call `planSimpleQuery()`; the former deterministic lookup bypass is gone.
- `planSimpleQuery()` scopes the prompt with `selectRelevantDatasets()`, which
  **ranks every table by intent relevance** (question-token overlap against table
  name/synonyms/columns, light singular stemming so "cases" matches `*_CASE`
  tables), pulls the top cluster plus FK neighbours, and deprioritises
  backup/archive copies (`bkp`/`archive`/`tmp`/…) so a stale duplicate never
  outranks the live table. Explicit `extractMentionedTables()` mentions and
  recent-conversation tables still win outright. Only when nothing scores does it
  fall back to a capped slice marked `truncated` (so the planner asks the user to
  name the table). Wide tables are then column-pruned by `pruneCatalogColumns()`
  (`ANALYTICS_CATALOG_PRUNE_THRESHOLD`/`_MAX_COLUMNS`) before the LLM call.
- Plain list queries may have no metric and select requested columns through
  `groupBy`.
- Vague entity-list questions such as `what are the cases?` use
  `select_columns` for a compact catalog-approved record projection. Validation
  requires an explicit projection for raw records, and the compiler rejects an
  empty projection instead of generating `SELECT *`.
- Explicit record-list wording takes precedence over partial KPI-name matches:
  `list the high priority cases that are resolved` stays Simple even when a
  certified KPI contains the generic tokens `resolved cases`. Exact weak
  `show <full KPI name>` wording and aggregate intent such as `how many`,
  `count`, or `total` remain KPI-eligible. Simple-to-KPI promotion applies the
  same entity-list guard. Conventional priority/state values explicitly named
  in an entity request are re-grounded to real selected-dataset columns after
  the mandatory planner call.
- Ad-hoc aggregates are not allowed in the active Simple validation call
  (`allowDynamicMetrics: false`). A proposed `SUM/COUNT/AVG/MIN/MAX(column)` that is
  not a certified KPI becomes a structured `NEEDS_KPI_MODE` response rather than a
  silently invented metric.

After Simple planning, `promoteCertifiedKpiPlan()` checks whether the proposed
metric name exactly matches a certified KPI. If so, it switches the run to KPI,
pins that KPI's formula context, datasets, joins, filters, and dimensions, and
re-applies all KPI ambiguity guards. This is a defense in depth for classifier
misses.

The Simple compiler has a final `CERTIFIED_METRIC_REQUIRES_KPI` guard. A certified
metric name reaching it fails as an internal routing/planning error and states that
no database query ran; it must never degrade into an `UNKNOWN_COLUMN` database
message.

### KPI dimension and filter guards

Certified KPI dimensions are a strict group-by allowlist. The orchestrator checks
them after planning, before sanitization, and again after sanitization because the
validator can infer a time-grain column.

`resolveMatchedKpiPlanDimensions()` also restores an omitted group-by when the user
explicitly says `by`, `per`, `grouped by`, `split by`, `breakdown by`, or `based on`
and names a configured dimension. Exact leaf column names define dimension sets:
`region` combines only with other configured `region` columns, while
`u_gsc_region` is a separate set. If the requested exact set occurs on multiple
KPI tables, the root dimension is retained as the canonical plan reference and
the compiler expands every joined base row across the distinct values from all
columns in that set. For example, a joined row containing `India` on the root and
`APAC` on a secondary table contributes once to both groups; if both values are
`India`, SQL `UNION` de-duplicates it and contributes once. A row receives one
`Unspecified` group only when every source value is null. For count KPIs, the
primary dataset key de-duplicates repeated master-join matches so the same case
is counted once per distinct group. Grouped totals may still exceed the ungrouped
KPI total by design when one case has multiple real dimension values. The saved
master join is not changed and no dimension-equality predicate is added.

Known implementation prefixes are removed only while interpreting natural
business wording, so `region` can resolve the sole configured `u_gsc_region` set.
If an exact `region` set also exists, it wins and is never merged with
`u_gsc_region`. Planner filters that are not grounded in the user's wording are
removed; certified KPI filters remain authoritative.

`findAmbiguousKpiFilterField()` applies the same protection to flat and nested
WHERE filters. Do not simplify either guard into "pick the first match" and do not
trust planner qualification as proof of user intent.

### Planner schemas and providers

`src/analytics/planner/index.ts` supplies shared clients for Groq, OpenRouter,
NVIDIA NIM, and generic OpenAI-compatible endpoints. Provider/model selection,
bounded local queuing, minimum call spacing, `Retry-After` handling, exponential
429 backoff with jitter, timeouts, and empty-response retry are centralized there.
Callers cannot override the configured provider model in production.

Keep LLM token metering centralized in `wrapWithRateLimit()`. Its structured-output
wrapper requests raw provider metadata for measurement, then unwraps the parsed
value so existing planner contracts remain unchanged. `telemetry/llmUsage.ts`
normalizes provider usage fields and calculates context utilization from
`LLM_CONTEXT_WINDOW_TOKENS` or `<PROVIDER>_CONTEXT_WINDOW_TOKENS`; do not create
provider-specific metering paths at individual call sites.

`LaxQueryPlanSchema` and `QueryPlanSchema` must accept explicit `null` for optional
planner fields such as `errorMode`, `conversationalAnswer`, and
`ambiguityDetails`. Some providers emit `null` rather than omit a property. Removing
`.nullable()` rejects otherwise usable tool output.

Planner prompts wrap user text as data, require exact catalog names, distinguish
schema questions from row-value questions, keep ranking metrics out of `groupBy`,
and represent a single date period as a filter rather than a trend. A coherent plan
is trusted over a contradictory model-reported `UNRECOGNIZED` flag.

### Validation and compilation

`sanitizeAndCorrectPlan()` normalizes nulls, datasets, columns, dates, filters,
sort/limit, joins, and time grains; it can find missing joins through relationship
BFS. `validatePlan()` then strictly verifies dataset/column existence, join columns,
a connected join graph, limits, and safe metric SQL.

KPI create/update validation in `routes/semanticLayer/kpiMetrics.ts` additionally
requires:

- qualified `table.column` dimensions and filter fields;
- exactly `N - 1` joins for an `N`-table KPI;
- one or more `ON` conditions per logical join edge, with legacy
  `leftColumn`/`rightColumn` retained as the first condition;
- join order rooted at the first involved table, with each next left table already
  connected and each right table new;
- no duplicate, self, cyclic, outside-scope, or disconnected joins;
- catalog-backed table/column references and a safe formula.

`src/sql/compiler.ts` exposes `compileKpiQuery()` and
`compileSimpleSelectQuery()`. It rewrites resolvable unqualified KPI formula columns,
rejects ambiguous formula columns, can synthesize missing joins from catalog
relationships, emits dialect-specific parameterized SQL, and enforces plan scope.
`compileKpiQuery()` merges runtime conditions into the saved master topology and
renders every condition in one `ON` clause joined by `AND`.

An INNER JOIN whose right-side rows are not consumed by the metric, SELECT, or
GROUP BY can become a `WHERE EXISTS` semi-join to prevent aggregate fan-out. Filters
that use only that joined table are pushed into `EXISTS`. An OR/filter unit spanning
multiple tables cannot be pushed, so the compiler retains a real join. Preserve
this distinction.

### Execution, quality, and response

Live adapters wrap execution in a 30-second timeout and normalize result rows.
`evaluateGroupedResultQuality()` blocks a grouped answer when all group labels are
null/blank and warns when only some are missing. That is a source-data issue, not a
planner/connection error.

`insightBuilder.ts` returns an answer, drivers, follow-ups, and a chart suggestion:
line for time grouping, bar for categorical grouping, scorecard for an ungrouped
metric. It deliberately returns `chart: null` for a plain list or a grouped result
whose values are all identical. Frontend code must preserve explicit `null` rather
than default it to a bar chart.

For a certified-KPI answer, follow-up suggestions are generated only from that
KPI's own `dimensions` allowlist (via the already-resolved `metricDef`), never
from the raw physical table's full column list — a KPI's dimensions are a small
curated subset of what's on the underlying table, and suggesting a breakdown by
whatever ungrouped column happens to exist produced unresolvable "by a business
dimension" suggestions that returned the same ungrouped answer when clicked. Only
an unused, configured, non-date dimension gets suggested, and it's named
concretely (`humanizeDimensionName()` strips the `u_gsc_`/`u_` prefix). No
breakdown suggestion is added at all once nothing valid is left. Non-KPI/Simple
queries keep the old raw-catalog-column heuristic, since there's no dimension
allowlist to check there.

`errorFormatter.ts` separates SQL planning/compilation errors, database failures,
LLM authentication/rate/quota/format/context/timeout errors, and circuit-breaker
failures. Pre-execution validation/routing failures should say no SQL ran and should
not recommend changing database connection settings.

## Routes

All `/api` routes require the API key:

- `POST /api/conversations`
- `DELETE /api/conversations/:id?connectionId=<id>`
- `DELETE /api/conversations?connectionId=<id>`
- `GET|POST /api/connections`
- `DELETE /api/connections/:id`
- `GET /api/connections/:id/health`
- `GET /api/data-catalog`
- `GET /api/data-catalog/:connectionId`
- `GET|POST /api/kpi-metrics`
- `GET|PATCH|DELETE /api/kpi-metrics/:id`
- `GET /api/kpi-metrics/columns/:connectionId`
- `GET /api/semantic-catalog`
- `GET /api/semantic-catalog/:connectionId`
- `GET /api/semantic-models/:connectionId`
- `POST /api/semantic-models/:connectionId/generate`
- `POST /api/semantic-models/:connectionId/regenerate-table`
- `DELETE /api/semantic-models/:connectionId/tables`
- `PUT /api/semantic-models/:connectionId`
- `POST /api/semantic-models/:connectionId/retry-vector-sync`
- `POST /api/assistant/ask`
- `GET|DELETE /api/assistant/conversations/:id`
- `POST /api/analytics/query`
- observability logs, live logs/export, metrics, circuit state, and SSE stream under
  `/api/observability`

Public documentation/system routes include `GET /docs`, `GET /api-docs.json`,
`GET /healthz`, and `GET /readyz`. The dynamic OpenAPI builder applies header
authentication to normal API operations and the query-key alternative only to
the SSE operation.

`buildAiCatalog()` filters sensitive/system columns, maps physical tables to stable
logical dataset names, infers relationships conservatively, and merges normalized
certified KPI relationships/metrics into the AI catalog. Planner and compiler
resolvers work with logical names while emitting physical table names.

## Frontend architecture

The frontend is React 19 + Vite 7 + Tailwind v4. It uses React Router v7, Redux
Toolkit for the older multi-tab analytics page, Zustand for semantic catalog cache,
Axios, Chart.js, Recharts, and Lucide.

### App shell and routes

`src/main.jsx` wraps the app in `BrowserRouter`, Redux `Provider`, and
`ThemeProvider`. `src/App.jsx` uses route-level error boundaries and
`lazyWithRetry()`, which reloads once after a stale chunk-load failure.

Routes:

- `/`: original company Dashboard with Dashboard AI/history in an overlay.
- `/Analytics`: compatibility redirect to `/`; the older Redux page is retired.
- `/Layer`: semantic-layer shell, redirecting to `DBConnections`.
- `/Layer/DBConnections`
- `/Layer/SemanticModels`
- `/Layer/KPIMetrics`

`SemanticTab.jsx` owns the active connection and persists
`active_connection_id`. `TabsHeader.jsx` currently exposes only Database
Connections, Semantic Models, and KPI Definitions. Analytics AI and Observability
remain implemented, but their frontend tab entries, lazy imports, and routes are
commented out.

### Important screens and state

- `DatabaseConnections.jsx`: CRUD for all eleven connection types. Deleting a
  connection clears both current and legacy query-history keys.
- `DataCatalog.jsx`: live schema browser with batched column rendering.
- `KpiDefinitions.jsx`: largest frontend module; null-first recursive filter AST editor,
  explicit `IS NULL`/`IS NOT NULL` rules, qualified column drag/drop,
  selected-table column search, typed dimension-to-chip resolution with ambiguity
  protection, KPI form validation, and a parent-aware rooted join-tree builder
  with root/child branches and multiple AND-combined conditions per table edge.
  Live catalog columns retain PK and auto-increment flags for badges and join
  selectors.
- `SemanticModelManager.jsx`: theme-preserving per-connection table/view picker,
  full and incremental controls, revision-safe JSON review/edit, generation state,
  and read-only normal-user presentation. The connection header is followed by
  Semantic JSON; the table/view picker and independently scrollable Modeled
  Entities panel form the responsive lower grid. Vector synchronization and audit
  metadata remain backend concerns and are intentionally not exposed in this screen.
- `LLMClassification.jsx`: mock simulation only. Its buttons do not call a backend
  classification route; the file explicitly carries a TODO and is not routed.
- `AnalyticsAssistant.jsx`: primary semantic-layer chat UI. It renders business answers
  and charts plus a development response inspector with Data, SQL (including
  bound parameters), Raw, and Trace tabs. Structured pipeline failures retain the
  inspector; transport failures without a response remain plain error bubbles. It
  creates a DB-backed conversation before the first query, reuses its ID, renews
  expired IDs, stores up to eight histories per connection in
  `query_history_<id>`, supports confirmed individual and connection-wide
  persistent deletion, resets a deleted active chat, displays at most 50 result
  rows, and offers business-safe KPI starter prompts. History deletion is
  disabled while a query or another deletion is active; a failed server delete
  leaves the browser history intact and displays the error.
- `Dashboard.jsx`: preserves the original company landing markup and behavior.
  Its existing prompt submits into `DashboardAssistantOverlay.jsx`; the only
  additive landing control is the history button in the original prompt toolbar.
- `DashboardAssistantOverlay.jsx`: product assistant/history container. It
  begins without a visible connection selector, lazily creates
  `user_conversations` after routing, preserves a sticky connection for
  follow-ups, renders the exported `AssistantResultCard` with the shared
  `RenderChart`, stores conversation-centric local history, exposes safe
  ambiguity cards, attributes every routed answer, and supports explicit
  re-routing without reflowing or restyling the Dashboard. Its shared inspector
  displays the backend's Dashboard-only trace prelude:
  `intent_connection_router` → `live_schema_introspection` →
  `schema_decision`, before the existing orchestrator tools.
- `ObservabilityDashboard.jsx` (retained but not currently routed): polls at `VITE_OBSERVABILITY_POLLING_INTERVAL_MS`, consumes
  the SSE hook, renders connector metrics/logs/circuit state, and downloads
  live-log exports through authenticated Axios requests. It conditionally renders
  aggregate, per-stage, and recent-call LLM token/context measurements from
  `/api/observability/token-usage` only when the backend returns `enabled: true`.
- `api/services.js`: central Axios wrapper. It attaches `x-api-key`, retries GETs
  twice for network/transient statuses, normalizes Axios errors, and defaults to the
  Vite proxy when no backend URL is configured.
- `catalogStore.js`: five-minute memory/localStorage cache of semantic-model
  datasets, with pending-request deduplication and explicit refresh/invalidation.

### Known frontend wiring constraints

- `VITE_API_KEY` is bundled into client JavaScript. User/session authentication is
  now enforced, but the shared frontend API key still means the current deployment
  model is intended for trusted/internal environments.
- Native `EventSource` cannot set the Axios header, so only the SSE stream accepts
  a query-string key. Request logs redact it. Export uses Axios/blob download and
  therefore keeps the key in the header.
- `.env.production` contains `VITE_MODELS`, but frontend source does not read it;
  LLM provider/model configuration belongs to the backend.

### Theming and rendering

`ThemeContext.jsx` maps `src/config/theme.json` into root CSS variables and persists
user changes in `app-theme`. `index.css` maps the same palette into Tailwind v4
tokens. For theme-aware UI, use existing variables such as
`--theme-primary`, `--theme-text`, `--theme-text-muted`, `--theme-border`,
`--theme-card-bg`, and `--theme-container-bg`, for example
`text-(--theme-text-muted)` or `bg-(--theme-card-bg)`.

Keep semantic status colors literal when red/green/amber communicates an error,
success, or warning. For Chart.js colors use `useThemeColor()` rather than adding
new raw `getComputedStyle` reads. Some admin/layout areas still contain hardcoded
gray/white styles; do not expand that debt when editing them.

For the Semantic Model workflow, preserving the established primary teal
`#0ca1b6`, warm background `#f5f4f1`, white surfaces, current typography/radii/
shadows, and desktop/mobile sidebar behavior is a non-negotiable acceptance rule.

Use `safeText` when rendering untrusted database/LLM values, shared number/date
formatters for display, and `InlineState`/`ASYNC_STATUS` for consistent loading,
empty, and error states.

## Environment map

Start from `backend/.env.example` and `frontend/.env.example`; never expose the real
files. Important backend groups:

- metadata DB: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`;
- auth/secrets: `API_KEY`, `CONNECTION_SECRET_KEY`, `APP_SECRET`, `DEPLOYMENT_ID`;
- server exposure: `PORT`, optional `PUBLIC_API_BASE_URL`, and `CORS_ORIGIN`;
- providers: `LLM_PROVIDER`, Groq/OpenRouter/NVIDIA/custom OpenAI-compatible keys,
  models, base URLs, bounded queue size/wait, minimum call intervals, 429 retries,
  tokens, and timeouts;
- LLM usage exposure: `SHOW_LLM_TOKEN_USAGE` defaults to `false`; when false,
  token events remain internally bounded but are removed from the public token
  endpoint, live-log API, SSE, exports, and frontend. Context percentage uses
  `LLM_CONTEXT_WINDOW_TOKENS` or a provider-specific override;
- orchestrator: `ANALYTICS_ORCHESTRATOR_MODE` (`deterministic | agent`) and the
  attempt/tool/recursion bounds; `agent` always reuses the provider-selected model;
- safety/resilience: circuit thresholds, `MAX_QUERY_LIMIT`, `MAX_CONVERSATIONS`,
  `RESULT_CACHE_MAX_ENTRIES`, `DATE_INPUT_ORDER`, `SQLITE_DATA_DIR`, SSL settings,
  telemetry limits, `REDIS_URL`, and `CORS_ORIGIN`.

Frontend source reads `VITE_BACKEND_URL` or `VITE_API_URL`, `VITE_API_KEY`,
`VITE_OBSERVABILITY_POLLING_INTERVAL_MS`, and `VITE_OBSERVABILITY_LOG_LIMIT`.
`services.js` falls back to
`default-dev-key`, and the provided frontend `.env.example` lists
`VITE_API_KEY`; set it to the same value as the backend.

## High-risk invariants for future changes

- Keep the orchestrator as the only analytics execution entry point.
- Never let the LLM supply executable SQL, physical identifiers outside the
  catalog, certified KPI formulas, or arbitrary joins.
- Preserve complete KPI dataset/join pinning and Simple-to-KPI promotion.
- Preserve all certified-KPI formula, dimension, selected-field, join, filter,
  relationship, and key columns during wide-catalog pruning.
- Preserve record-list output shape ahead of partial generic KPI matches, at
  both initial classification and Simple-to-KPI promotion.
- Never restore an analytics `SELECT *` fallback; raw-record plans must name
  catalog-validated output columns.
- Preserve dimension-context exclusion in conflicting-measure detection.
- Preserve the `based on` group-by inference, root-anchored shared-dimension join
  conditions, and filter ambiguity checks at every checkpoint.
- Preserve `CERTIFIED_METRIC_REQUIRES_KPI` and pre-execution error wording.
- Preserve planner schema nullability and empty-response retry behavior.
- Preserve connected `N - 1` KPI join trees, multi-condition master edges, and
  compiler semi-join fan-out protection.
- Preserve explicit `chart: null` and grouped-null data-quality responses.
- Treat provider quota/rate/format/timeout failures as AI-service problems, not
  database failures.
- Check `CompleteFixes.txt` before removing a safety check that appears redundant;
  most duplicated checks guard different mutation points in the pipeline.

## Current limitations

- Single-word KPI names can still over-match unrelated questions. Previous keyword
  tweaks regressed common phrasing; address this with a stronger semantic approach,
  not another untested token heuristic.
- Provider quality varies. Free-tier quota exhaustion and small-model planning
  inconsistency are operational realities; do not encode provider-specific output
  guesses into validators or compilers.
- The optional LangGraph tool wrapper retains a narrow `any` boundary, with typed
  validation around authoritative run state.
- Route, adapter, circuit-breaker concurrency, and browser integration coverage is
  still limited.
- Result-cache reads remain dormant in the analytics request path.

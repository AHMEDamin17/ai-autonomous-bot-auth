# ANONYMOUS_AI

ANONYMOUS_AI is a full-stack semantic-layer analytics application. It lets users save database connections, inspect live schemas, define governed KPI metrics, and ask natural-language analytics questions that are compiled into parameterized SQL and executed against live data.

The project is a monorepo with an Express + TypeScript backend and a React + Vite frontend.

## Current Status

The active `anonymous_ai` branch is the current implementation; the adjacent
`KPI/` folder is the older Python/FastAPI prototype. Recent updates include:
- **Authenticated per-connection semantic models (2026-08-03):** the metadata
  database is now `autonomous_db`; versioned users/HttpOnly sessions and
  admin/user roles protect writes; each connection has an immutable semantic
  key and one authoritative MySQL semantic document. Full, append, one-table
  regenerate, no-LLM remove, optimistic JSON save, and vector retry are exposed
  through `/api/semantic-models/:connectionId`. Qdrant `v1.18.2` is the fixed
  derived vector store and local Ollama `0.32.0` supplies 768-dimensional
  `nomic-embed-text:v1.5` embeddings through a durable outbox. The Semantic Model
  tab preserves the existing teal/warm-white theme and is read-only for normal
  users. See `WORKFLOW.md` for the current flow and secure next steps.
- **Clean fresh-install baseline and login gate (2026-08-03):** metadata setup now
  uses only `migrations/001_init.sql`, which creates the complete current schema.
  Setup-only copy artifacts and empty legacy KPI columns are gone. The frontend
  renders a theme-matched sign-in page before any Dashboard or semantic-layer
  screen, and backend port conflicts exit with a concise actionable message.
- **Semantic-model-routed Dashboard AI (2026-08-03):** the retired Summary tab,
  API, generator, and storage columns are gone. Dashboard connection selection
  now ranks healthy SQL connections with
  ready, schema-valid semantic models using bounded business context that excludes
  physical table and column identifiers. Analytics AI and Observability remain
  implemented in source, but their semantic-layer tabs and routes are currently
  commented out.
- **Dashboard AI:** the product assistant uses a separate,
  lazy-created Dashboard conversation store. `POST /api/assistant/ask` ranks
  eligible healthy SQL connections, asks the user
  when the score gap is ambiguous, pins the selected connection for follow-ups, and
  falls through only when routed setup reports that a database is unavailable.
  Both analytics APIs delegate to `executeResolvedAnalyticsQuery()` and the
  same orchestrator. The `/` page preserves the original company Dashboard
  layout; its existing prompt opens source attribution, re-routing, and
  conversation-centric history in a contained assistant overlay. `/Analytics`
  redirects home. Dashboard responses prepend three product-only trace entries:
  semantic-model/sticky connection routing, live metadata introspection, and the
  validated schema decision; the admin Analytics AI trace is unchanged.
- **LLM Token and Context Observability (2026-07-27):** every routed/planner
  model call now captures provider-reported input, output, and total tokens plus
  configured-context utilization. The Observability tab shows aggregate,
  per-stage, and recent-call measurements only when
  `SHOW_LLM_TOKEN_USAGE=true`; the company-safe default hides token events from
  the API, SSE stream, exports, and frontend without disabling bounded internal
  collection.
- **End-to-end persistent conversations (2026-07-23):** `AnalyticsAssistant.jsx` now
  creates a real backend conversation before the first query, reuses its ID,
  renews expired conversations, and stores the backend ID with local history.
  The backend enforces that a conversation belongs to the selected connection
  before using its context. Individual deletion and connection-wide Clear
  History now remove the persisted server conversation(s), cascade their
  messages, and reset the active chat when applicable.
- **Scoped browser authentication:** query-string API keys are accepted only by
  the native `EventSource` observability stream. Export now downloads through
  Axios with the normal `x-api-key` header, and request logging redacts sensitive
  query parameters.
- **Accurate dynamic OpenAPI:** `/docs` and `/api-docs.json` auto-discover the
  live Express routes, use the real KPI/analytics request fields, apply security
  per route, and no longer embed a machine-specific LAN address.
- **Tracked documentation:** this README, the complete workflow, agent guidance,
  orchestrator-mode guide, changelog, runbooks, and dump generator are maintained
  as repository source rather than ignored local files.
- **Mandatory LLM Semantic Entry**: Every analytics question now requires a successful call to the single model selected by `LLM_PROVIDER`. Plain KPI scorecards, explicit table/column lookups, catalog questions, greetings, and connectionless intake no longer have non-LLM answer fallbacks. Backend code still owns read-only enforcement, catalog/KPI validation, parameterized SQL compilation, and execution.
- **Query Pipeline Reliability Pass**: Full audit of the router, KPI pipeline, and simple pipeline fixed a pre-query keyword router that was hijacking ordinary questions before they reached either pipeline, a `NULL`-aggregate rendering bug ("undefined" answers), a crash on nearly every uncertified "total/sum/average of X" question, multi-column `GROUP BY` silently collapsing to one dimension, and several SQL-compiler/executor timeout and join-safety bugs. See `CompleteFixes.txt` Part 9 for the full list.
- **Real Conversation Memory**: `conversationContext` (last answer, recently-referenced tables/columns) is now actually threaded into both LLM planner prompts to resolve pronoun follow-ups ("what can we group it by?") — previously collected but silently unused.
- **LLM Schema & Provider Hardening**: Fixed a Zod schema bug (`errorMode`/`conversationalAnswer`/`ambiguityDetails` needed `.nullable()`, not just `.optional()`) that caused some providers' tool-calling to reject entire valid plans; added catalog scoping so large schemas don't blow a smaller model's context window; split a previously-mislabeled "prompt too large" error into three accurate messages.
- **Theme-Compliant Output Display**: Replaced hardcoded Tailwind gray/slate/white colors with the app's `--theme-*` CSS-variable system across the chart, results, and observability views; charts are no longer shown for plain list queries or uniform-value results where a chart carries no information.
- **KPI Builder UI Overhaul** (v3): AST-based filter tree (`FilterGroupCard`) and a rooted join specification UI to prevent cycle joins.
- **Multi-condition KPI joins and combined dimensions**: each rooted table edge can store multiple saved `ON` predicates. Saved KPI joins remain authoritative. A requested dimension configured under the same exact column name on multiple KPI tables is grouped across the distinct values from all of those columns without adding a dimension-equality predicate.
- **Metadata privacy and key-aware catalog UI**: Analytics AI blocks table/schema/column enumeration after the mandatory LLM interpretation and removes technical starter prompts. During development, each executed response retains Data, SQL, Raw, and Trace inspection tabs. The KPI builder preserves primary-key/auto-increment metadata for badges and join selectors.
- **Backend Hardening** (v4): database pooling for all adapters, API Key middleware, eliminated Redis O(N) cache leaks.

Validated commands:

```powershell
npm.cmd run test
npm.cmd run test:implementation
npm.cmd run build
npm.cmd run lint
```

Current backend self-test coverage: 124 cases (28 SQL compiler/security + 96 regression).

## Repository Layout

```text
ANONYMOUS_AI/
  backend/
    migrations/001_init.sql     Complete fresh-install metadata schema
    scripts/migrate.ts           Migration runner
    scripts/verifyCurrentSchema.ts
    scripts/schemaBaselineSelftest.ts
    src/
      analytics/                 NL-to-SQL planning, validation, execution
      connections/               Catalog/live connector pool registry
      db/                        Metadata MySQL connection
      mcp/                       Resilience and security helpers
      routes/                    Express API routes
      semanticModels/            Per-connection model generation/store/outbox
      sql/                       Parameterized SQL compiler
      telemetry/                 Logs, metrics, live telemetry
      types/                     Shared TypeScript types and error codes
      utils/                     Connection testing, errors, secrets
      main.ts                    Bootstrap and graceful shutdown
      server.ts                  Express app setup
  frontend/
    src/
      api/                       Axios service layer
      components/                Layout and feature pages
      hooks/                     Frontend hooks
      store/                     Zustand/Redux state
      utils/                     UI utilities
  backend_complete.txt           Generated backend source dump
  frontend_complete.txt          Generated frontend source dump
  generate_project_dump.ps1      Dump generator script
  docker-compose.yml             Local Qdrant + Ollama stack
  package.json                   Root convenience scripts
```

## Tech Stack

Backend:
- Node.js 18+
- Express
- TypeScript
- MySQL metadata store through `mysql2`
- Zod validation
- LangChain/LangGraph for AI planning
- Drivers for MySQL/MariaDB, PostgreSQL/Redshift, SQL Server, SQLite, Snowflake, BigQuery, Databricks, MongoDB, and Redis

Frontend:
- React 19
- Vite 7
- React Router
- Axios
- Zustand and Redux Toolkit
- Chart.js, Recharts
- Lucide icons

## Root Scripts

Run these from `ANONYMOUS_AI/`:

```powershell
npm.cmd run build
npm.cmd run test
npm.cmd run lint
```

Root script behavior:
- `build`: builds backend, then frontend
- `test`: runs backend SQL compiler and regression self-tests
- `lint`: runs frontend ESLint

## Backend Scripts

Run from `ANONYMOUS_AI/backend/`:

```powershell
npm.cmd run dev
npm.cmd run build
npm.cmd run start
npm.cmd run test
npm.cmd run migrate
```

Backend script behavior:
- `dev`: starts `tsx src/main.ts` under nodemon
- `build`: compiles TypeScript into `dist/`
- `start`: runs compiled server on port `3005`
- `test`: runs `src/sql/compiler.ts --selftest`, then
  `src/tests/regression.test.ts --selftest`
- `migrate`: applies SQL migrations through `scripts/migrate.ts`

## Frontend Scripts

Run from `ANONYMOUS_AI/frontend/`:

```powershell
npm.cmd run dev
npm.cmd run build
npm.cmd run lint
npm.cmd run preview
npm.cmd run e2e
```

## Local Setup

1. Install dependencies:

```powershell
npm.cmd install
npm.cmd install --prefix backend
npm.cmd install --prefix frontend
```

2. Create backend environment file:

```powershell
Copy-Item backend\.env.example backend\.env
```

3. Create frontend environment file:

```powershell
Copy-Item frontend\.env.example frontend\.env
```

4. Create an empty MySQL database named `autonomous_db` (or set `DB_NAME` to your
   empty metadata database) and configure its connection in `backend/.env`.

5. Run migrations:

```powershell
npm.cmd run migrate --prefix backend
```

6. Start backend:

```powershell
npm.cmd run dev --prefix backend
```

7. Start frontend:

```powershell
npm.cmd run dev --prefix frontend
```

Default URLs:
- Backend API: `http://localhost:3005`
- Frontend: `http://localhost:5173`

Run only one backend process. `EADDRINUSE` means another process already owns
port 3005; it is unrelated to login state. Keep the healthy existing backend,
or stop it before starting another. The frontend shows the sign-in gate until a
valid HttpOnly session is established.

## Backend Environment Variables

Defined in `backend/.env.example`:

```text
PORT=3005
PUBLIC_API_BASE_URL=

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=root
DB_NAME=autonomous_db

LLM_PROVIDER=groq
LLM_MAX_COMPLETION_TOKENS=1024
LLM_MAX_RETRIES=1
LLM_RATE_LIMIT_ENABLED=true
LLM_MAX_CONCURRENT=1
LLM_MAX_QUEUE_SIZE=100
LLM_MAX_QUEUE_WAIT_MS=60000
LLM_RATE_LIMIT_MAX_RETRIES=2
LLM_RATE_LIMIT_RETRY_BASE_MS=2000
LLM_RATE_LIMIT_RETRY_MAX_MS=60000
SHOW_LLM_TOKEN_USAGE=false
LLM_CONTEXT_WINDOW_TOKENS=128000

# Orchestration mode: deterministic (default) or agent. See notes below.
ANALYTICS_ORCHESTRATOR_MODE=deterministic
ANALYTICS_ORCHESTRATOR_RECURSION_LIMIT=30
ANALYTICS_ORCHESTRATOR_MAX_TOOL_CALLS=18
ANALYTICS_PLANNER_MAX_ATTEMPTS=3
ANALYTICS_DB_MAX_ATTEMPTS=2

GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MIN_INTERVAL_MS=12000

# OpenRouter (set LLM_PROVIDER=openrouter to activate; standby/fallback provider)
OPENROUTER_API_KEY=
# Free model IDs rotate — check https://openrouter.ai/api/v1/models before assuming
# an entry here is still live. Prefer one whose /endpoints response shows a healthy
# `status` and `structured_outputs: true` (this project calls `.withStructuredOutput()`
# on every planning request).
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
# Random free-pool alternative: openrouter/free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MIN_INTERVAL_MS=3200
OPENROUTER_MAX_CONCURRENT=1
OPENROUTER_HTTP_REFERER=http://localhost:5173
OPENROUTER_APP_TITLE="Autonomous AI Analytics"

CONNECTION_SECRET_KEY=replace-with-a-long-random-secret
DEPLOYMENT_ID=local-dev

# Optional OpenAI-compatible model endpoint
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_API_KEY=sk-local-dev
# LLM_MODEL=llama3.1:8b

CIRCUIT_FAILURE_THRESHOLD=2
CIRCUIT_SUCCESS_THRESHOLD=3
CIRCUIT_COOLDOWN_MS=15000
CIRCUIT_DECAY_MS=60000
MAX_TELEMETRY_LOGS=500
MAX_QUERY_LIMIT=100
MAX_CONVERSATIONS=10
RESULT_CACHE_MAX_ENTRIES=500
SQLITE_DATA_DIR=./data
DATE_INPUT_ORDER=MDY
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=true
LATENCY_SAMPLE_RATE=0.05

REDIS_URL=
CORS_ORIGIN=http://localhost:5173
```

Important notes:
- `CONNECTION_SECRET_KEY` should be a long random value in real deployments.
- `GROQ_API_KEY` is intentionally blank in examples.
- Use `LLM_PROVIDER=groq`, `openrouter`, or `nvidia` (or `openai` for a custom OpenAI-compatible `LLM_BASE_URL` endpoint) after setting the matching API key. That provider and its model setting are the only analytics model selection path; both the ReAct orchestrator agent and the semantic planners reuse the same model.
- **NVIDIA NIM** (`LLM_PROVIDER=nvidia`) is OpenAI-compatible ([docs](https://docs.api.nvidia.com/nim/reference/llm-apis)). Set `NVIDIA_API_KEY` and pick any `NVIDIA_MODEL` from [build.nvidia.com](https://build.nvidia.com/models) that supports tool calls + structured output; base URL defaults to `https://integrate.api.nvidia.com/v1`. **`meta/llama-3.1-8b-instruct` is fast but has repeatedly proven unreliable in live testing** (silently dropped date filters/groupBy, spurious ambiguous-query rejections — see `CompleteFixes.txt` §13, §19) — **`LLM_PROVIDER=groq` is the validated reliable default**; only use NVIDIA if Groq is unavailable, and prefer its larger models over the 8B if you do.
- For OpenRouter (a standby/fallback provider, not the default), the free model lineup rotates — check `https://openrouter.ai/api/v1/models` and each candidate's `/endpoints` response before picking one; prefer a healthy `status` and `structured_outputs: true`. `openrouter/free` remains available as a random free-pool alternative, but its selected model and provider availability can vary between calls. Even a well-chosen free model has shown its own reliability issues (dropped constraints, unparseable structured output) in one-off testing — treat any OpenRouter free model as a fallback, not a primary.
- `ANALYTICS_ORCHESTRATOR_MODE` chooses **who advances the guarded workflow**. Both modes require an LLM semantic entry and retain the same backend-owned guards and deterministic response assembly:
  - **`deterministic`** (default, recommended): backend code starts with
    `query_classifier_tool`, then `pre_query_guard_tool`, and invokes the LLM at
    `planner_tool`. A clean request spends one planner call and remains
    quota-efficient and predictable.
  - **`agent`**: a LangGraph ReAct agent (an LLM) chooses which tool to call next each turn (~1 LLM call per tool, ~8 per request) — more autonomous but slower and ~5–8× more provider quota; size rate limits accordingly.
  - Any other value is rejected as a configuration error instead of silently selecting a mode.
  - `ANALYTICS_ORCHESTRATOR_RECURSION_LIMIT` and `ANALYTICS_ORCHESTRATOR_MAX_TOOL_CALLS` bound the loop (the recursion limit specifically bounds the agent).
- `LLM_MAX_COMPLETION_TOKENS` keeps provider token-budget estimates bounded, and `*_MIN_INTERVAL_MS` throttles outbound LLM calls per provider/model. Provider 429 responses honor `Retry-After` and use bounded exponential backoff with jitter; queue size and wait time are bounded by `LLM_MAX_QUEUE_SIZE` and `LLM_MAX_QUEUE_WAIT_MS`.
- `SHOW_LLM_TOKEN_USAGE=true` exposes provider-reported token/context
  measurements in `GET /api/observability/token-usage`, live telemetry, SSE,
  exports, and the Observability tab. Its company-safe default is `false`, which
  hides those values while collection remains in the bounded telemetry buffer.
  `LLM_CONTEXT_WINDOW_TOKENS` supplies the denominator for context utilization;
  use `<PROVIDER>_CONTEXT_WINDOW_TOKENS` (for example,
  `GROQ_CONTEXT_WINDOW_TOKENS`) when providers or deployed models differ.
- `DATE_INPUT_ORDER` controls slash/dash date parsing in natural-language filters. `MDY` treats `01-07-2025` as January 7, 2025; use `07-01-2025` for July 1, 2025. ISO dates such as `2025-07-01` are safest and unaffected.
- `REDIS_URL` is optional. If absent, the app uses in-memory cache/circuit-breaker behavior.
- `CORS_ORIGIN` supports comma-separated origins.
- **Free-tier LLM quotas are small and easy to exhaust during testing** and may include request, token, and daily budgets. Local spacing and retries cannot bypass an exhausted account quota or unavailable upstream capacity. For production reliability, select a provider/model with sufficient paid capacity rather than assuming a free model is unlimited.
- **`.env` changes require a process restart** — `nodemon` (used by `npm run dev`) only watches `src/**/*.ts`, not `.env`, so editing an API key or model name won't take effect until you stop and restart the dev server.

## Frontend Environment Variables

Defined in `frontend/.env.example`:

```text
VITE_BACKEND_URL=http://localhost:3005
VITE_API_KEY=default-dev-key
VITE_OBSERVABILITY_POLLING_INTERVAL_MS=5000
VITE_OBSERVABILITY_LOG_LIMIT=50
```

## API Routes

Backend base API prefix: `/api`

Mounted route groups:
- `/api/conversations`
- `/api/connections`
- `/api/data-catalog`
- `/api/kpi-metrics`
- `/api/semantic-catalog`
- `/api/semantic-models`
- `/api/assistant`
- `/api/analytics`
- `/api/observability`

Conversation lifecycle:
- `POST /api/conversations`
- `DELETE /api/conversations/:id?connectionId=<id>` deletes one owned
  conversation idempotently.
- `DELETE /api/conversations?connectionId=<id>` permanently clears every
  conversation for the selected connection.
- `POST /api/assistant/ask` lazily creates and pins a Dashboard conversation
  after safe connection routing.
- `GET|DELETE /api/assistant/conversations/:id` reads or removes one Dashboard
  conversation.

API documentation:
- `GET /docs` - interactive Swagger UI
- `GET /api-docs.json` - generated OpenAPI 3.0 document

Health endpoints:
- `GET /healthz`
- `GET /readyz`

Analytics, Dashboard assistant, and observability route groups are rate-limited
by the in-memory/Redis-aware rate limiter.

## Frontend Routes

Current frontend routes:
- `/` - original company Dashboard with Dashboard AI/history in an overlay
- `/Analytics` - compatibility redirect to `/`
- `/Layer` - semantic layer shell
- `/Layer/DBConnections`
- `/Layer/SemanticModels`
- `/Layer/KPIMetrics`

The Analytics AI and Observability frontend routes are currently commented out;
their implementation files and backend APIs remain available for later re-entry.

Each route is wrapped with its own error boundary so one page crash does not take down the entire app shell.

## Supported Connection Types

| Type | Metadata | SQL analytics execution | Notes |
| --- | --- | --- | --- |
| MySQL | Yes | Yes | Pooled |
| MariaDB | Yes | Yes | Uses MySQL driver |
| PostgreSQL | Yes | Yes | Pooled |
| Redshift | Yes | Yes | Uses PostgreSQL driver |
| SQL Server / MSSQL | Yes | Yes | Pooled |
| SQLite | Yes | Yes | Read-only file access inside `SQLITE_DATA_DIR` |
| Snowflake | Yes | Yes | Per-adapter connection |
| BigQuery | Yes | Yes | `credentials_json` preferred |
| Databricks | Yes | Yes | Client pooled, sessions closed per adapter |
| MongoDB | Yes | No | Catalog only |
| Redis | Stub | No | Catalog stub only |

MongoDB and Redis are not SQL-queryable through Analytics AI.

## Analytics Pipeline

The backend builds a semantic catalog from live database metadata and
user-defined KPIs, then sends resolved analytics requests through one shared
LLM-first orchestrator (`ANALYTICS_ORCHESTRATOR_MODE` selects deterministic-loop
or ReAct-agent tool ordering). The admin API supplies a connection directly;
the Dashboard API first ranks healthy connections with ready semantic models.

1. **Mandatory semantic entry**: every question calls the model selected by `LLM_PROVIDER`. There is no deterministic query-answer or KPI-scorecard fallback when the provider is unavailable. Connectionless questions also pass through the model before an informational answer or connection requirement is returned.
2. **Shared orchestrator** (`analytics/orchestrator/analyticsOrchestrator.ts`): `runAnalyticsOrchestrator()` is the only KPI/Simple execution entry point. In **deterministic** mode (default) backend code follows each tool's structured `next` pointer; in **agent** mode a LangGraph ReAct agent chooses the next tool. Either way the tools enforce ordering and share backend-owned state, so execution can never run SQL out of order or fabricate results.
   Both HTTP surfaces reach it through
   `analytics/executeResolvedAnalyticsQuery.ts`, which owns connection/catalog/
   adapter setup, circuit state, and telemetry. Dashboard routing lives
   upstream in `analytics/router/semanticModelConnectionRouter.ts`; close scores return safe
   `connection_selection_required` cards instead of executing SQL.
3. **Planner entry** (`planner_tool`): the third tool in both modes (after `query_classifier_tool` and `pre_query_guard_tool`), and the only one that invokes the configured LLM. Deterministic KPI token/phrase scoring (`query_classifier_tool`) only scopes the prompt and selects the validation profile; it cannot answer the question. Explicit `mode: "simple"` forces the Simple validation profile. A **measure-conflict guard** prevents an unrelated KPI from being pinned.
   Tables above the catalog-width threshold are pruned before the prompt while
   retaining primary/relationship keys, entity display fields,
   question-overlap columns, and every column referenced by a certified KPI
   formula, dimension, selected field, join, or filter.
4. **KPI profile**: the matched KPI's metric, tables, formula, filters, dimensions, and saved master joins remain authoritative. Explicit named months such as `Nov 2025` are deterministically converted into an inclusive month range on the KPI’s configured date dimension, so a provider omission cannot silently return the all-time scorecard. Configured dimensions are an enforced group-by allowlist. Exact leaf names define separate dimension sets: `region` and `u_gsc_region` are not combined. When one exact set occurs on multiple KPI tables, the primary dimension is the canonical plan reference and every joined base row expands across the distinct values from all same-named columns. A row whose values are `India` and `APAC` contributes once to both groups; equal values are de-duplicated with SQL `UNION`; and a row appears once as `Unspecified` only when all source values are null. Count KPIs use the primary dataset key to prevent duplicate master-join matches from counting the same case more than once per group. Grouped totals can still exceed the ungrouped KPI total by design when one case has multiple real values. The saved master join is unchanged and no dimension-equality predicate is appended. Natural wording such as `region` may resolve the sole configured `u_gsc_region` set, but an exact `region` set wins when both exist. Missing dimensions still require a KPI update. The planner may add requested sorting, limits, and query filters but cannot redefine the KPI; planner filters not grounded in the user's wording are removed while certified KPI filters remain authoritative.
5. **Simple profile**: the planner may select catalog datasets/columns/joins, while validation blocks uncertified ad-hoc aggregates with `NEEDS_KPI`. Explicit entity-list wording owns the record-output shape, so a partial KPI-name match on generic words such as `resolved cases` cannot turn `list the high priority cases that are resolved` into a scorecard. Vague entity-list questions receive a compact catalog-approved projection, and explicit conventional status/priority wording becomes catalog-backed filters after the mandatory planner call. Dataset-only raw plans are rejected and the analytics compiler never falls back to `SELECT *`. Row-value requests still compile and execute; metadata-enumeration requests are blocked after the LLM call and never list database structures.
6. **Tools**: both modes run the same eight, in the same order — `query_classifier_tool`, `pre_query_guard_tool`, `planner_tool`, `validator_tool`, `sql_compiler_tool`, `db_execute_tool`, `result_quality_tool`, `insight_builder_tool`. Only `planner_tool` calls the LLM; the rest are deterministic backend code in both modes. All tools share backend-owned run state, so the LLM never edits compiled SQL or bypasses validation.
7. **Dynamic trace**: traces are recorded in actual invocation order and include attempt number and duration instead of being sorted through a hard-coded linear step list.

### End-to-end orchestrated request

```text
POST /api/analytics/query (admin, explicit connection)
or POST /api/assistant/ask (Dashboard, semantic-model routing)
  -> authentication, request validation, correlation ID, rate limit
  -> Dashboard only: route and lazily pin user_conversations
  -> executeResolvedAnalyticsQuery()
  -> connection + KPI definitions + live semantic catalog
  -> database compatibility and circuit-breaker checks
  -> runAnalyticsOrchestrator()
       -> query_classifier_tool (deterministic KPI/Simple profile selection, no LLM)
       -> pre_query_guard_tool (read-only/date guards, no LLM)
       -> planner_tool (mandatory LLM semantic entry; create or revise a plan)
       -> validator_tool (sanitize, merge filters, enforce catalog/KPI rules)
       -> sql_compiler_tool (create parameterized SQL owned by the backend)
       -> db_execute_tool (execute only that compiled SQL)
       -> result_quality_tool (block or warn on unusable grouped values)
       -> insight_builder_tool (answer, drivers, follow-ups, chart)
  -> deterministic response finalizer
  -> conversation history, telemetry, circuit state, HTTP response
```

The list above is the normal successful path, not the removed fixed `ORDERED_TRACE_STEPS` pipeline. Each next tool is chosen from that tool's structured result — by backend code in `deterministic` mode or by a LangGraph ReAct agent in `agent` mode — so validation/compiler/database feedback can branch back to `planner_tool`. Backend prerequisites reject unsafe ordering, changing a plan invalidates downstream state, and a per-run queue serializes calls against shared state. Tool calls, planner attempts, database attempts, and agent recursion are bounded by environment limits.

## SQL Compiler Safety

The compiler in `backend/src/sql/compiler.ts` is designed around safe SQL generation:
- validates identifiers before quoting
- emits dialect-specific parameter placeholders
- binds values as query parameters
- rejects raw SQL filter nodes
- supports structured `filter_logic`
- stores no-filter intent as `null`; empty groups and incomplete draft conditions
  are not accepted as meaningful filters
- supports explicit `IS NULL` and `IS NOT NULL` conditions without bound values;
  the string `"null"` remains an ordinary literal value for other operators
- supports relative time filters like `today`, `yesterday`, `this_month`, `last_month`, `this_year`, `last_year`, `last_30_days`
- has self-tests for SQL injection rejection and relative time behavior

Legacy KPI raw filter strings are no longer compiled. Use structured `filter_logic` condition/group nodes instead.

## Security And Resilience

Implemented hardening:
- connection secrets encrypted at rest with AES-256-GCM
- `enc:v2` secret format uses PBKDF2 with per-secret salt
- legacy plaintext and `enc:v1` values remain readable for compatibility
- no live API keys should be committed
- `/analytics/query` body validation through strict Zod schema
- SQLite files restricted to `SQLITE_DATA_DIR`
- Redis circuit breaker keys scoped by `DEPLOYMENT_ID`
- circuit breaker half-open probe is single-flight
- in-memory rate limiter cleanup interval
- conversation history persisted in `conversations`/`conversation_messages` tables (not in-memory — survives backend restarts), with a periodic DB cleanup interval for expired conversations
- result cache TTL and max entry cap
- telemetry cache atomic temp-file write and rename
- adapter and metadata pools track pending closes
- graceful shutdown closes adapter pools, metadata pools, and the app metadata DB pool

## Metadata Database Migrations

Fresh installations use one current-schema baseline:

```text
001_init.sql
```

It creates the complete current authentication, connection, KPI, conversation,
telemetry, semantic-model, vector-outbox, and migration-ledger schema directly.
Run `npm.cmd run test:schema --prefix backend` to prove a blank temporary database
can be created from the baseline, and `npm.cmd run verify:schema --prefix backend`
to verify the configured database has exactly the expected runtime tables.

## Observability

The backend records:
- execution logs
- connector metrics
- latency samples
- live in-memory telemetry
- provider-reported LLM input/output/total tokens and context-window utilization
- circuit breaker state
- SSE observability stream

Telemetry controls:
- `MAX_TELEMETRY_LOGS`
- `LATENCY_SAMPLE_RATE`
- `SHOW_LLM_TOKEN_USAGE`
- `LLM_CONTEXT_WINDOW_TOKENS` or `<PROVIDER>_CONTEXT_WINDOW_TOKENS`
- `VITE_OBSERVABILITY_POLLING_INTERVAL_MS`
- `VITE_OBSERVABILITY_LOG_LIMIT`

`GET /api/observability/token-usage` returns totals, per-stage measurements, and
recent LLM calls when display is enabled. It returns only `{ "enabled": false }`
when the company policy flag is off.

## Generated Source Dumps

The project includes `generate_project_dump.ps1`, which creates:
- `backend_complete.txt`
- `frontend_complete.txt`

Run it from `ANONYMOUS_AI/`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\generate_project_dump.ps1
```

The script skips secrets, build artifacts, tests, caches, and generated dependency folders.

## Git Tracking Notes

Project documentation, operational runbooks, and `generate_project_dump.ps1` are
trackable source. Ignored examples are limited to superseded plans, generated
outputs, dependencies, secrets, and runtime artifacts:
- `ANONYMOUS_AI/ARCHITECTURE.md`
- `ANONYMOUS_AI/REFACTOR_PLAN.md`
- `ANONYMOUS_AI/backend/dist/`
- `ANONYMOUS_AI/node_modules/`
- `ANONYMOUS_AI/backend/.telemetry_cache.json`

## Latest Verification Snapshot

Current fresh-baseline/login pass (see `CompleteFixes.txt` Part 18):
- A blank temporary database builds successfully from only `001_init.sql` and
  verifies at exactly 14 runtime tables. The configured database matches the same
  contract and its migration ledger contains only that baseline.
- The setup-only copy audit table and empty legacy KPI columns are gone. All
  remaining tables have active runtime consumers.
- Unauthenticated browsers see only the theme-matched sign-in gate. Frontend lint
  and build pass, and duplicate backend startup reports the port-3005 conflict
  cleanly without an unhandled-event stack.

Current Summary-removal pass (see `CompleteFixes.txt` Part 17):
- Active source contains no Summary page, API, generator, services, or storage
  references, and its three retired columns are absent from the baseline.
- Analytics AI and Observability remain implemented but are currently excluded
  from frontend navigation and route wiring. `ObservabilityDashboard` is not in
  the active build; shared result components from `AnalyticsAssistant` remain in
  the build because the Dashboard assistant reuses them.
- Active tests pass at 28 compiler plus 96 regression cases; the complete
  implementation bundle, backend/frontend builds, frontend lint, OpenAPI route
  inspection, and desktop/mobile theme checks also pass.

Newest pass (see `CompleteFixes.txt` §32–33):
- A new/reset KPI now stores "no filter" as real `null`, first presenting a
  **Create Filters** prompt instead of an empty pre-rendered Match group. That
  empty group used to still get submitted, which the backend correctly
  rejected (`filter_logic: ["Array must contain at least 1 element(s)"]`) —
  the group-schema `.min(1)` rule was right, the frontend just needed to stop
  sending an empty shell (and the schema was tightened to `.nullable()` too,
  so an explicit `null` for "no filter" is now equally valid). Filter
  conditions also support explicit `IS NULL`/`IS NOT NULL`, and join branches
  are parent-aware (sibling joins from the root, child joins from any
  connected right table, with correct branch-only deletion).
- A certified KPI's "Suggested Follow-ups" no longer offers a breakdown by
  "a business dimension" — a vague placeholder that always appeared (nearly
  every table has *some* groupable column) but never resolved to anything
  when clicked, silently returning the same ungrouped answer again. It now
  only suggests a follow-up naming a real, unused, KPI-configured dimension
  (e.g. "Break down volume resolved by region"), or no breakdown suggestion
  at all if none is left.

Current pass (see `CompleteFixes.txt` Part 12):
- Analytics AI creates and reuses DB-backed conversations; expired or mismatched
  IDs are renewed by the UI, and cross-connection context is blocked. History
  supports owned individual deletion and confirmed connection-wide clearing;
  deleting the active entry also resets the open chat.
- Query-string authentication is restricted to the SSE stream, sensitive query
  values are redacted from HTTP logs, and exports authenticate through Axios
  headers.
- The generated OpenAPI document discovers the live API and its KPI fields,
  analytics body, success statuses, examples, and per-route security match the
  executable routes.
- Backend self-tests pass: 28 compiler cases plus 96 regression cases.
- Backend and frontend builds and frontend lint pass.

As of the latest pass (see `CompleteFixes.txt` §17–21 for full detail):
- the deterministic orchestrator loop starts at `query_classifier_tool` again (a regression had it starting at `planner_tool`, silently folding classification/guards into the planner call and hiding them from the execution trace) — verified live with full 8-step traces on both happy-path and early-terminal runs
- `LLM_PROVIDER=groq` (`llama-3.3-70b-versatile`) confirmed as the reliable provider after NVIDIA's free 8B model reproduced known dropped-filter/spurious-ambiguous failures live against `gsconnectdev`
- `kpiPlanner.ts` no longer gives the model an undocumented `errorMode: "AMBIGUOUS"` escape hatch for KPI queries — that decision was already owned deterministically by backend guards, the model just didn't know not to guess at it too
- conversation history moved from an in-memory `Map` to real `conversations`/`conversation_messages` tables, alongside `db_connections`/`kpi_metrics`; a real mutation bug was found and fixed along the way (`addMessage` was stripping `data.rows` from the same object reference later sent as the actual API response, not just from storage)
- a live, read-only data-quality investigation (not a code bug) traced two alarming KPI results on `gsconnectdev` to a genuine source-data gap: `u_gsc_region` is populated on ~0.01% of in-scope case rows

Historical v9 verification:
- a full router/KPI-pipeline/simple-pipeline/compiler/executor bug audit was completed and every confirmed finding fixed or explicitly documented as a deliberate trade-off (see `CompleteFixes.txt` Part 9)
- API security is strictly enforced via `API_KEY` middleware
- database connection pool leaks (SQLite, Snowflake, BigQuery) have been entirely resolved
- the query router no longer intercepts ordinary questions before they reach a pipeline
- `LaxQueryPlanSchema`/`QueryPlanSchema` accept `null` for optional planner fields, matching what providers' tool-calling actually emits
- conversation context is genuinely used by the LLM planners, not just stored
- charts are suppressed (backend and frontend) when there's nothing meaningful to plot
- frontend output surfaces (chat results, charts, observability) route through the app's `--theme-*` token system instead of hardcoded colors
- that earlier snapshot had fewer tests; the authoritative current count is 112
  total cases
- backend and frontend builds pass
- frontend lint passes

Commands used:

```powershell
npm.cmd run test
npm.cmd run build
npm.cmd run lint
```

## Known Remaining Work

These are not blocking the core analytics pipeline:

- LangChain's `tool` helper still requires a narrow `any` boundary at the orchestrator integration point; all tool inputs and authoritative run state remain validated and typed around that boundary.
- MSSQL SSL currently uses `encrypt: false` in some connection configs. `DB_SSL` currently covers MySQL/PostgreSQL paths.
- More integration tests would be useful for route-level behavior, DB adapters, and circuit-breaker concurrency.
- `queryClassifier.ts`'s single-word KPI name matching (e.g. a KPI literally named "Revenue") can over-match unrelated sentences containing that word. Two heuristic fixes were tried and reverted because both regressed common real phrasing worse than the edge case they fixed — a real fix would need semantic similarity (embeddings), not more keyword-scoring adjustments.
- A handful of builder/admin UI surfaces (`KpiDefinitions.jsx` form inputs, `Sidebar.jsx`, `Footer.jsx`) still have some hardcoded Tailwind gray colors not yet routed through `--theme-*` — lower priority since the fix so far focused on output-display surfaces (chat results, charts, observability) per explicit request.

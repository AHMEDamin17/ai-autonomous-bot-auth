# Implementation Plan - `autonomous_db`, authentication, Qdrant, and per-connection semantic models

Status: **COMPLETE.** Progress and verification are recorded in `TRACKER.md`.

This is the completed historical implementation record. Do not replay its cutover
or backfill phases on a new server. `WORKFLOW.md` and the single current-schema
baseline describe fresh installation.

---

## 0. Final decisions

These decisions are fixed for this implementation:

1. **Qdrant is the final vector database.** Milvus and other vector databases are
   out of scope.
2. The metadata database moves from `icon_component_db` to `autonomous_db`, with
   existing project data preserved and the old database retained for rollback.
3. MySQL is the authoritative semantic-model store. Qdrant is a derived semantic
   search index and is repaired asynchronously when synchronization fails.
4. There is one standalone semantic-model document per database connection.
5. The first Qdrant design uses one collection named `semantic_models` and one
   point per connection. This supports connection-level retrieval. Finer entity-
   or table-level RAG points are a later enhancement.
6. Embeddings run locally through Ollama using `nomic-embed-text` and must return
   exactly 768 dimensions.
7. Semantic generation is manual. Adding a database connection does not
   automatically call the LLM.
8. Generation uses two passes: application overview followed by one normal detail
   call per selected table. Wide-table splitting is a bounded fallback.
9. Authentication uses username/password plus a server-issued opaque session in
   an HttpOnly cookie. JWT is not required. `X-User-Id` is not trusted and will not
   be used as authentication.
10. The numeric `db_connections.id` remains private to storage and URLs. Semantic
    JSON uses an immutable public `semantic_key`.

### Authorization matrix

| Capability | admin | user |
| --- | --- | --- |
| Login/logout and view own profile | Yes | Yes |
| Run Dashboard/Analytics queries and manage own conversations | Yes | Yes |
| Read connections, catalogs, KPIs, and semantic models | Yes | Yes |
| Create/update/delete connections and KPIs | Yes | No |
| Generate/edit/remove semantic-model entities | Yes | No |
| Retry vector synchronization | Yes | No |
| Create/deactivate users or change roles | Yes | No |

Hard-delete of users is not supported. Users are deactivated so audit references
remain valid.

### Explicit non-goals

- This plan prepares Qdrant for future RAG but does not add a user-facing RAG
  question-answering route.
- It does not add JWT, SSO, OAuth, or external identity providers.
- It does not create one Qdrant point per table/entity in this release.
- It does not automatically infer relationships when a source database exposes no
  foreign-key metadata. In that case, `relationships` is empty.

---

## 1. Target semantic JSON

Each connection owns exactly one document:

```jsonc
{
  "version": "1.0",
  "model_name": "SupplyChainAnalytics",
  "domain": "PharmaSupplyChain",
  "description": "Supply Chain Analytics Semantic Model",
  "datasource": {
    "connection_id": "mysql_supply_chain",
    "database_name": "supply_chain_db"
  },
  "entities": [
    {
      "name": "Orders",
      "table_name": "fact_orders",
      "description": "Order transactions",
      "primary_keys": ["order_id"],
      "dimensions": [
        {
          "name": "Order Date",
          "column_name": "order_date",
          "datatype": "date",
          "description": "Date on which the order was placed"
        }
      ],
      "measures": [
        {
          "name": "Revenue",
          "expression": "quantity * unit_price",
          "aggregation": "sum",
          "datatype": "decimal",
          "format": "currency",
          "description": "Extended order revenue"
        }
      ]
    }
  ],
  "relationships": [
    {
      "name": "orders_customer",
      "source_entity": "Orders",
      "target_entity": "Customer",
      "source_column": "customer_id",
      "target_column": "customer_id",
      "cardinality": "many_to_one",
      "role": "customer"
    }
  ]
}
```

### Datasource rules

- `datasource.connection_id` is the connection's immutable `semantic_key`.
- The initial key is `<normalized_db_type>_<slug(connection_name)>`.
- If that value already exists, append a short random UUID suffix. Never append
  the numeric database ID.
- Renaming a connection does not change its `semantic_key`.
- `database_name` is required and is a safe logical database/scope label. For
  MySQL/MariaDB/PostgreSQL/Redshift/MSSQL it comes from `default_schema`; for
  BigQuery it is the dataset; for Databricks it is the schema; for SQLite it is
  only the file name, never the full local path.
- Databricks/Snowflake may additionally use `catalog` and `schema`.
- BigQuery may additionally use `project` and `dataset`; the project ID is treated
  as logical scope metadata, not as a network host.
- Optional scope fields are emitted only when the connection supplies them.
- Hostnames, usernames, credentials, numeric connection IDs, and secrets never
  appear in the semantic JSON.

### Field ownership

Deterministic backend code owns and validates:

- `version`, `datasource`, and the physical `table_name` identity.
- Physical column names, source datatypes, and primary keys.
- Relationships derived from foreign-key metadata.
- Referential integrity between entities and relationships.

The LLM authors:

- `model_name`, `domain`, and model description.
- Entity display names and descriptions.
- Dimension display names and descriptions.
- Suggested measures and their descriptions.

Every LLM measure expression must pass a server-side allowlist and may reference
only columns belonging to that entity. Invalid or unknown expressions fail
generation; they are never silently saved.

---

## PHASE 0 - Safe `autonomous_db` cutover

**Goal:** reproduce the current schema in `autonomous_db`, copy existing data,
validate it, and switch without modifying `icon_component_db`.

- [x] **0.1 Preflight**
  - Stop backend writes for the short cutover window.
  - Confirm the configured MySQL account can create a database and read both
    schemas.
  - Record source table names, row counts, migration versions, and foreign keys.
  - Refuse to continue if `autonomous_db` contains partial/unverified data.

- [x] **0.2 Shared migration runner**
  - Extract the reusable migration logic from `backend/scripts/migrate.ts` so a
    target database can be passed explicitly without editing global environment
    state.
  - Preserve the existing lexicographic migration behavior and migration history.

- [x] **0.3 `backend/scripts/setupAutonomousDb.ts`**
  - `CREATE DATABASE IF NOT EXISTS autonomous_db` using the configured charset and
    collation.
  - Run baseline migrations `001` through `014` against `autonomous_db`. Do not use
    `CREATE TABLE ... LIKE`, because it does not preserve foreign keys.
  - Copy rows from current application tables in foreign-key dependency order.
  - Treat `schema_migrations` as migration state produced by the migration runner;
    compare it with the source instead of blindly duplicating rows.
  - Run the copy in a consistent read window and fail loudly on duplicate or
    partial data.
  - A rerun is a no-op only when the completed destination matches the recorded
    source counts and migration versions; otherwise it stops for explicit repair.

- [x] **0.4 Validation report**
  - Compare row counts for every copied table.
  - Verify expected primary keys, indexes, and foreign keys through
    `information_schema`.
  - Run explicit orphan checks for every foreign key.
  - Verify several known connections, KPIs, conversations, and the existing
    semantic document can be read from the destination.

- [x] **0.5 Cutover and rollback**
  - Change `DB_NAME=autonomous_db` in `backend/.env.example`.
  - Change the local real `.env` manually without printing or copying secrets.
  - Run migrations, start the backend, and confirm `/healthz` and `/readyz`.
  - Confirm existing connections and KPIs in the UI.
  - Rollback is changing `DB_NAME` back to `icon_component_db`; do not drop the old
    database in this plan.

**Acceptance:** schema objects and row counts match; foreign keys exist; the app
runs against `autonomous_db`; the old database is unchanged and usable for rollback.

---

## PHASE 1 - Real users, sessions, and roles

**Goal:** authenticate users from the sidebar and derive trusted `req.user` from a
server-side session.

- [x] **1.1 Migration `015_auth_users_sessions.sql`**
  - Create `users` with `username` unique, `password_hash`, `role`, `is_active`, and
    complete audit/timestamp columns.
  - Create `user_sessions` with a SHA-256 token hash, `user_id`, creation time,
    expiration time, last-seen time, and revocation time.
  - Add indexes for active-session lookup and expiry cleanup.
  - Use nullable self-referencing user audit FKs so the first bootstrap user can be
    created safely.

- [x] **1.2 Secure bootstrap**
  - Add `backend/scripts/bootstrapAdmin.ts`.
  - Read the initial username/password from explicit environment variables or
    interactive input. Do not ship default passwords or plaintext credentials in
    migrations, documentation, logs, or commits.
  - Make the script idempotent: create the first admin only when it does not exist.
  - After insertion, stamp the bootstrap admin's own audit fields.

- [x] **1.3 Password and session utilities**
  - `backend/src/auth/password.ts`: versioned salted Node `crypto.scrypt` hashes,
    constant-time verification, and safe malformed-hash handling.
  - `backend/src/auth/session.ts`: generate at least 256 bits of randomness, store
    only SHA-256 token hashes, rotate on login, revoke on logout, and enforce an
    environment-controlled expiry.
  - Add bounded cleanup of expired/revoked sessions.

- [x] **1.4 Auth routes**
  - `POST /api/auth/login`: API key + rate limit; verify credentials; set the
    HttpOnly session cookie; return safe user data.
  - `POST /api/auth/logout`: revoke the current session and clear the cookie.
  - `GET /api/auth/me`: return the current authenticated user.
  - `POST /api/auth/change-password`: verify the current password, change it, and
    revoke all other sessions.
  - Production cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, bounded `Max-Age`.
  - Local development cookie: `HttpOnly`, non-secure, `SameSite=Lax`.

- [x] **1.5 Middleware order**
  - Keep `requireAuth` as the shared service/API-key gate.
  - Mount login after the API-key gate but before user-session enforcement.
  - Apply `requireUserSession` to the remaining `/api` routes.
  - Load the user from the hashed session token and set typed `req.user`.
  - Never accept `X-User-Id` and never default a missing session to admin.
  - Add trusted-origin checks for unsafe cookie-authenticated requests.
  - Parse the session cookie with a small audited helper or add `cookie-parser` and
    its TypeScript types; do not implement ad-hoc parsing at multiple call sites.
  - Enable credentialed CORS only for the explicit configured origin allowlist.
    Never combine credentialed cookies with a wildcard origin.

- [x] **1.6 User administration**
  - Admin-only list/create/update/deactivate routes.
  - Usernames are immutable in the first release.
  - Role changes and deactivation revoke that user's active sessions.
  - Prevent deactivation of the final active admin.

- [x] **1.7 Frontend authentication**
  - Add `AuthProvider`/`useAuth` with `/auth/me` bootstrap; do not store a user ID or
    session token in `localStorage`.
  - Configure Axios with `withCredentials: true`.
  - Add `ProfileMenu.jsx` to desktop and mobile sidebar avatars.
  - Logged out: username/password form. Logged in: username, role, change password,
    and logout.
  - A session `401` clears local auth state and prompts for login without treating
    an API-key failure as a user credential failure.

**Acceptance:** valid login creates a server-side session; a forged user header has
no effect; logout/revocation immediately invalidates the session; role-protected
routes return `403`; no password or raw session token is stored in MySQL or browser
storage.

---

## PHASE 2 - Audit stamping and stable semantic keys

**Goal:** stamp domain writes from authenticated users and create stable public
connection identities.

- [x] **2.1 Migration `016_domain_audit_and_semantic_keys.sql`**
  - `db_connections`: add `updated_at`, `created_by`, `updated_by`, and immutable
    unique `semantic_key`.
  - `kpi_metrics`: add `created_by` and `updated_by` while preserving existing
    timestamps.
  - Add user FKs and indexes for audit lookups.
  - Add nullable `user_id` ownership FKs/indexes to `conversations` and
    `user_conversations`. These are ownership fields, not audit columns.
  - Keep audit user columns nullable at the database level so historical imports
    and bootstrap recovery remain possible.

- [x] **2.2 Historical audit backfill**
  - Add `backend/scripts/backfillAuditUsers.ts` to stamp existing rows to the
    selected bootstrap admin.
  - Add `backend/scripts/backfillSemanticKeys.ts` to assign semantic keys in
    connection-ID order, adding a short random UUID suffix only for collisions.
  - Backfill existing conversation ownership to the selected bootstrap admin.
  - Print counts only; do not print user secrets or connection credentials.

- [x] **2.3 Route stamping and connection update**
  - Stamp `created_by`/`updated_by` from trusted `req.user.id` in connection, KPI,
    and user-management writes.
  - Add admin-only `PATCH /api/connections/:id` and the matching edit UI, because
    connection update auditing otherwise has no write path.
  - Connection rename does not alter `semantic_key`.
  - Return safe audit display data where the UI needs it.
  - Pass `req.user.id` into both conversation stores. Create, load, append, and
    delete operations must be scoped to the authenticated owner; knowing another
    conversation UUID must not grant access.

**Acceptance:** all new domain rows have the correct acting user; edits update
`updated_at`/`updated_by`; duplicate connection names receive distinct stable
semantic keys; renaming does not change a key; users cannot read, append to, or
delete another user's conversations.

---

## PHASE 3 - Local Qdrant and Ollama infrastructure

**Goal:** run the fixed vector stack locally with persistent storage and health
checks.

- [x] **3.1 Root `docker-compose.yml`**
  - Qdrant service on `6333`, using a named persistent volume.
  - Ollama service on `11434`, using a named persistent volume.
  - A one-shot Ollama initialization service that waits for Ollama and pulls
    `nomic-embed-text:v1.5` when missing.
  - Health checks for both services.
  - Pin explicit tested image versions; do not use floating `latest` tags.
  - No sign-in is required for this local stack.

- [x] **3.2 Dependencies and configuration**
  - Add `@qdrant/js-client-rest` to the backend.
  - Add validated configuration:

    ```env
    QDRANT_URL=http://localhost:6333
    QDRANT_API_KEY=
    QDRANT_COLLECTION=semantic_models
    QDRANT_TIMEOUT_MS=10000
    EMBEDDINGS_BASE_URL=http://localhost:11434/v1
    EMBEDDINGS_MODEL=nomic-embed-text:v1.5
    EMBEDDINGS_DIM=768
    EMBEDDINGS_TIMEOUT_MS=30000
    ```

- [x] **3.3 Embedding client**
  - `backend/src/vector/embeddings.ts` calls `/v1/embeddings` with bounded timeout.
  - Support batch input internally even if the first workflow embeds one connection
    at a time.
  - Reject empty, non-finite, or non-768-dimensional vectors.
  - Build a deterministic bounded `summaryText(model)` containing model metadata,
    entity/table names, descriptions, dimensions, and measures. Do not depend on
    embedding an unlimited raw JSON document.

- [x] **3.4 Qdrant client**
  - `ensureCollection()` creates `semantic_models` with 768-dimensional cosine
    vectors.
  - Existing collection configuration must be inspected; a dimension/distance
    mismatch fails clearly and is never recreated automatically.
  - Use the private numeric connection ID directly as the Qdrant point ID.
  - Payload includes the full model JSON, numeric storage connection ID,
    `semantic_key`, model revision, and timestamps.
  - Add upsert, retrieve, delete, and semantic search functions.

- [x] **3.5 Health behavior**
  - `/healthz` remains process/MySQL health.
  - `/readyz` reports MySQL, Qdrant, and embeddings separately.
  - Qdrant/Ollama failure is shown as degraded for administrative CRUD; it must not
    corrupt or block saving the authoritative MySQL model.

**Acceptance:** compose reaches healthy state; embedding produces exactly 768
finite numbers; collection creation is idempotent; upsert/retrieve/delete work; a
query embedding returns the expected dummy connection through similarity search.

---

## PHASE 4 - Per-connection MySQL storage and durable vector synchronization

**Goal:** introduce the authoritative per-connection model store alongside the
legacy combined store, without switching the UI yet.

- [x] **4.1 Migration `017_per_connection_semantic_models.sql`**

  - First enforce `db_connections.semantic_key NOT NULL`; Phase 2 backfill is a
    required checkpoint before this migration is added or applied to an existing
    database.

  Create `semantic_models` with:

  - `connection_id` primary key and cascading FK to `db_connections`.
  - `model_json LONGTEXT NULL`.
  - `status`: `none | generating | ready | error`.
  - `generation_job_id`, `generation_started_at`, `generation_error`, and
    `last_generated_at`.
  - Monotonic `revision` for optimistic concurrency.
  - `vector_status`: `not_indexed | pending | ready | error`.
  - `vector_error` and `vector_updated_at`.
  - Complete create/update audit columns and user FKs.

  Create `semantic_vector_outbox` with:

  - Durable `upsert | delete` operation.
  - Connection ID, target model revision, attempt count, next-attempt time,
    lock/lease fields, and last error.
  - No FK to `db_connections`, so a Qdrant delete job survives relational cascade.
  - A uniqueness/deduplication rule that keeps only the latest effective operation
    per connection.

- [x] **4.2 Store contract**
  - `getModel(connectionId)` reads MySQL only.
  - `saveModel(connectionId, model, expectedRevision, userId)` validates JSON,
    increments revision, marks vector sync pending, and enqueues the outbox event in
    the same MySQL transaction.
  - `deleteModel` or connection deletion enqueues a durable Qdrant delete operation
    in the same relational transaction.
  - Manual edits change `updated_at` but not `last_generated_at`.
  - A failed new generation preserves the previous valid `model_json` and revision.

- [x] **4.3 Vector outbox worker**
  - Start from `main.ts` after database readiness.
  - Claim jobs with a bounded database lease so multiple backend processes cannot
    process the same job concurrently.
  - For upsert, ignore superseded revisions and embed the latest authoritative
    MySQL model.
  - Retry transient Qdrant/Ollama failures with capped exponential backoff.
  - Record terminal diagnostics without silently dropping a job.
  - Support graceful shutdown and an admin retry operation.

- [x] **4.4 Validation schema**
  - Add a backend Zod schema for the complete document.
  - Enforce one entity per canonical physical table, unique entity names, valid
    column references, valid measure expressions, and valid relationship targets.
  - Deterministic datasource and relationship fields cannot be changed by a manual
    edit; reject the save with field-specific errors rather than silently accepting
    changes.
  - Add an explicit semantic-model request-size limit appropriate for large models
    instead of relying accidentally on the current global 1 MB limit.

**Acceptance:** a MySQL save succeeds while Qdrant is offline and is later repaired;
revisions prevent stale overwrites; deleting a connection eventually deletes the
Qdrant point; an invalid model never reaches either store.

---

## PHASE 5 - Two-pass application-aware incremental generation

**Goal:** generate a coherent model for selected tables and change only the
requested scope during append/regeneration/removal.

- [x] **5.1 Pass 1: connection overview**
  - Input: safe connection label/type/scope, selected canonical table identities,
    column names and types, primary keys, foreign keys, and names/descriptions of
    governed KPIs for that connection.
  - Never send hosts, usernames, credentials, secrets, numeric connection IDs, or
    sample row values.
  - Structured output: `model_name`, `domain`, `description`, and table role
    classification.
  - Validate structured output with Zod and use the existing centralized provider,
    timeout, rate-limit, and usage-metering path.

- [x] **5.2 Pass 2: one entity per table**
  - Normal path is one LLM call per table with Pass-1 context plus that table's
    complete safe metadata.
  - Deterministic code restores physical table/column names, datatypes, and primary
    keys after the call.
  - Validate all suggested dimensions and measures against the table allowlist.
  - Wide tables may be split into bounded column chunks only after a measured
    context/truncation failure; merge chunks deterministically and revalidate the
    single final entity.
  - Apply configured retry/call/time bounds so a large connection cannot generate
    indefinitely.

- [x] **5.3 Deterministic relationships**
  - Build only from catalog foreign keys whose source and target tables are both
    present in the model.
  - Recompute relationships after full generation, append, regeneration, removal,
    or manual save.
  - Empty FK metadata produces an empty relationship list.

- [x] **5.4 Operations**
  - `generateFull(connection, selectedTables)`: Pass 1 plus Pass 2; resulting model
    contains exactly the selected tables.
  - `appendTables(connection, selectedTables, existingModel)`: preserve model-level
    fields and existing entities; generate only missing selected tables using the
    existing model overview as context.
  - `regenerateTable(connection, table, existingModel)`: regenerate only that
    entity and recompute relationships incident to it.
  - `removeTable(connection, table, existingModel)`: remove only that entity and
    relationships incident to it; no LLM call.
  - Full regeneration is the explicit operation for recalculating model-level
    overview fields after major schema changes.

- [x] **5.5 Generation lease and recovery**
  - Acquire the connection row atomically before setting `generating`; only one
    generation job per connection may run.
  - Concurrent generation/edit/remove requests return `409 MODEL_BUSY`.
  - Keep the previous ready model visible while a replacement generates.
  - On success, atomically save the model, clear errors, increment revision, set
    `last_generated_at`, and enqueue vector synchronization.
  - On failure, preserve the prior model and store a safe error.
  - On startup, expired generation leases become `error` with an interrupted-job
    message and may be retried by the user.

**Acceptance:** three selected tables produce a valid coherent model; append calls
the LLM only for new tables; regeneration changes only the selected entity plus its
incident relationships; removal uses no LLM; overlapping jobs cannot overwrite one
another.

---

## PHASE 6 - Stable API contracts and legacy endpoint separation

**Goal:** expose the new store without colliding with the current deterministic AI
catalog endpoints.

- [x] **6.1 Separate the existing semantic catalog**
  - Move the current deterministic `GET /api/semantic-models` and
    `GET /api/semantic-models/:connectionId` behavior to
    `GET /api/semantic-catalog` and `GET /api/semantic-catalog/:connectionId`.
  - Update `frontend/src/stores/catalogStore.js` and any other consumers.
  - Keep internal `buildAiCatalog()` behavior unchanged.
  - Reuse `GET /api/data-catalog/:connectionId` for the Semantic Model table picker;
    do not add a duplicate `/connections/:id/tables` route.

- [x] **6.2 Per-connection semantic-model endpoints**
  - `GET /api/semantic-models/:connectionId` returns connection label/key, model,
    revision, generation state/error, vector state/error, timestamps, and safe audit
    user display data. If no row exists, return a synthesized `status: "none"` with
    `model: null`.
  - `POST /api/semantic-models/:connectionId/generate` with
    `{ tables: string[] | "all", mode: "full" | "append" }` returns `202` and a
    generation job ID.
  - `POST /api/semantic-models/:connectionId/regenerate-table` with
    `{ table, revision }` returns `202`.
  - `DELETE /api/semantic-models/:connectionId/tables` with
    `{ table, revision }` avoids unsafe table names in the URL.
  - `PUT /api/semantic-models/:connectionId` with `{ model, revision }` performs a
    validated optimistic save.
  - `POST /api/semantic-models/:connectionId/retry-vector-sync` retries indexing
    without regenerating the model.

- [x] **6.3 Response and error rules**
  - Use the existing `{ data, message? }` success envelope.
  - Use stable errors: `MODEL_BUSY`, `STALE_MODEL_REVISION`,
    `INVALID_SEMANTIC_MODEL`, `UNKNOWN_TABLE`, `GENERATION_FAILED`, and
    `VECTOR_SYNC_FAILED`.
  - Authorization failures are `401` or `403`; validation is `400`; missing
    connection is `404`; concurrency/stale revision is `409`; accepted background
    work is `202`.
  - Never expose provider responses, credentials, prompts, or stack traces.

**Acceptance:** old catalog consumers continue through `/semantic-catalog`; every
new endpoint has request/response tests; stale revisions and concurrent jobs return
deterministic `409` responses.

---

## PHASE 7 - Semantic Model tab rework

**Goal:** connection selection, table selection, incremental controls, JSON review,
and visible generation/vector state.

- [x] **7.1 Selection flow**
  - Select one connection.
  - Load its live catalog through `/api/data-catalog/:connectionId`.
  - Show searchable table/view checkboxes with Select all/Clear all.
  - Full Generate replaces the model with exactly the selected tables after a
    confirmation when an existing model would lose entities.

- [x] **7.2 Model display and editing**
  - Render generated JSON below the selection controls.
  - Show deterministic fields as locked or reject modifications with precise inline
    validation errors.
  - Save with the loaded revision; on `409`, reload and warn instead of overwriting
    newer work.
  - Show `last_generated_at`, `updated_at`, generating user, last editing user, and
    current revision.

- [x] **7.3 Incremental controls**
  - Add tables uses append and generates only missing selected tables.
  - Regenerate table acts only on the selected entity.
  - Remove table requires confirmation and uses no LLM.
  - Disable writes while that connection is generating.

- [x] **7.4 Status and recovery**
  - Poll only while generation or vector synchronization is pending.
  - Display generation failure separately from vector-index failure.
  - Keep showing the last valid MySQL model when Qdrant is unavailable.
  - Admin can retry vector sync without regenerating.

**Acceptance:** an admin can generate selected tables, edit/save, append, regenerate,
remove, and recover from vector failure; a normal user can view but sees no enabled
write controls.

---

## PHASE 8 - Legacy conversion and cleanup

**Goal:** preserve useful legacy semantic data, switch completely to the new flow,
then remove the combined-document implementation.

- [x] **8.1 Legacy conversion script**
  - Add `backend/scripts/migrateLegacySemanticModels.ts`.
  - Split the existing combined `semantic_model_doc` using
    `semantic_model_part_bindings`.
  - Map each valid legacy connection part to the current connection and normalize it
    into the new per-connection schema.
  - Do not overwrite a newer generated per-connection model.
  - Invalid/unmappable parts are reported and retained in the legacy tables for
    review.
  - Enqueue Qdrant indexing for successfully imported models.

- [x] **8.2 Switch and verify**
  - Remove frontend calls to `/combined`, `/generate-all`, and legacy
    `/generate/:connectionId`.
  - Confirm every expected connection is ready or deliberately left `none`.
  - Export a local backup of legacy model rows without credentials.

- [x] **8.3 Migration `018_drop_legacy_semantic_model_doc.sql`**
  - Drop `semantic_model_part_bindings` first, then `semantic_model_doc`, only after
    the conversion verification passes.
  - Remove combined model types, queue/merge functions, routes, services, and UI.
  - Replace `resetOrphanedGeneration` with the new per-connection lease recovery.

**Acceptance:** no runtime code references combined documents or `{ parts: [...] }`;
legacy data has either been imported or explicitly reported before tables are
dropped; the new UI/API is the only semantic generation path.

---

## PHASE 9 - Verification, security review, and documentation

**Goal:** prove the complete cutover and synchronize tracked documentation.

- [x] **9.1 Automated backend coverage**
  - Password hashing, session expiry/revocation, role enforcement, and audit stamps.
  - Migration numbering and autonomous database copy validation helpers.
  - Semantic-key collision and rename stability.
  - Embedding dimension/timeout failures and Qdrant configuration mismatch.
  - Outbox retry, superseded revision, and delete-after-connection behavior.
  - Generator structured-output validation, wide-table fallback, incremental scope,
    generation lease, restart recovery, and stale edits.
  - API status/error contracts.

- [x] **9.2 Frontend verification**
  - Login/logout/session expiry.
  - Admin/user control visibility.
  - Full/append/regenerate/remove/save flows.
  - Generation and vector failure states.
  - Run frontend lint and build.

- [x] **9.3 Full commands**

  ```powershell
  npm.cmd run test
  npm.cmd run build
  npm.cmd run lint
  docker compose ps
  ```

  Run Playwright only when the backend, frontend, `autonomous_db`, test connection,
  Qdrant, and Ollama prerequisites are available.

- [x] **9.4 Documentation synchronization**
  - Rewrite `WORKFLOW.md` so it contains only the current database-connection and
    per-connection semantic-generation flow plus concrete next steps. Do not retain
    obsolete feature-removal commentary.
  - Update `README.md`, `AGENTS.md`, `AUTONOMOUS_AI_COMPLETE_WORKFLOW.md`, and
    `CompleteFixes.txt` where behavior changed.
  - Update `ORCHESTRATOR_MODES.md` only if the analytics orchestrator contract was
    affected.
  - Document local Qdrant/Ollama start, model pull, health checks, persistence,
    backup, and safe shutdown.

**Final acceptance:** all active tests/build/lint pass; the UI runs on
`autonomous_db`; authentication and role enforcement work; per-connection models
are authoritative in MySQL and eventually indexed in Qdrant; incremental operations
are scoped correctly; legacy combined storage is gone; documentation matches the
implemented behavior.

---

## Current fresh-install migration

The completed local cutover was consolidated after verification. New servers apply
only `backend/migrations/001_init.sql`, which creates the final schema directly.
Future schema changes start at `002`.

---

## Main new and changed files

### Backend

- `scripts/bootstrapAdmin.ts`
- `scripts/verifyCurrentSchema.ts`
- `scripts/schemaBaselineSelftest.ts`
- `scripts/lib/currentSchema.ts`
- `scripts/lib/migrationRunner.ts`
- `migrations/001_init.sql`
- `src/auth/password.ts`
- `src/auth/session.ts`
- `src/middleware/requireUserSession.ts`
- `src/middleware/requireRole.ts`
- `src/routes/auth.ts`
- `src/routes/users.ts`
- `src/vector/embeddings.ts`
- `src/vector/qdrantStore.ts`
- `src/vector/outboxWorker.ts`
- `src/analytics/semanticGenerator/index.ts`
- `src/analytics/semanticGenerator/store.ts`
- `src/routes/semanticLayer/semanticCatalog.ts`
- `src/routes/semanticLayer/semanticModels.ts`
- `src/routes/semanticLayer/connections.ts`
- `src/routes/semanticLayer/kpiMetrics.ts`
- `src/routes/router.ts`
- `src/server.ts`
- `src/main.ts`

### Frontend

- `src/auth/AuthContext.jsx`
- `src/auth/LoginGate.jsx`
- `src/components/layout/ProfileMenu.jsx`
- `src/components/layout/Sidebar.jsx`
- `src/components/pages/semanticLayer/tabs/DatabaseConnections.jsx`
- `src/components/pages/semanticLayer/tabs/SemanticModelManager.jsx`
- `src/components/pages/semanticLayer/tabs/KpiDefinitions.jsx`
- `src/components/pages/semanticLayer/tabs/AnalyticsAssistant.jsx`
- `src/components/pages/semanticLayer/tabs/ObservabilityDashboard.jsx`
- `src/stores/catalogStore.js`
- `src/api/services.js`

### Root and documentation

- `docker-compose.yml`
- `.env.example` files as applicable
- `WORKFLOW.md`
- `README.md`
- `AGENTS.md`
- `AUTONOMOUS_AI_COMPLETE_WORKFLOW.md`
- `CompleteFixes.txt`

---

## Environment additions

```env
# Metadata database
DB_NAME=autonomous_db

# Initial administrator bootstrap - local secret values only, never commit them
BOOTSTRAP_ADMIN_USERNAME=
BOOTSTRAP_ADMIN_PASSWORD=

# Session configuration
SESSION_COOKIE_NAME=ai_session
SESSION_TTL_HOURS=8

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=semantic_models
QDRANT_TIMEOUT_MS=10000

# Local embeddings
EMBEDDINGS_BASE_URL=http://localhost:11434/v1
EMBEDDINGS_MODEL=nomic-embed-text
EMBEDDINGS_DIM=768
EMBEDDINGS_TIMEOUT_MS=30000

# Existing semantic-generation bounds
SEMANTIC_GEN_MAX_TOKENS=4096
SEMANTIC_GEN_TIMEOUT_MS=120000

# New generation/outbox bounds
SEMANTIC_GEN_MAX_TABLES=100
SEMANTIC_GEN_JOB_LEASE_MS=900000
SEMANTIC_VECTOR_MAX_ATTEMPTS=10
SEMANTIC_VECTOR_WORKER_INTERVAL_MS=5000
```

All new environment values must be parsed and range-validated at startup. Real
passwords, API keys, database credentials, and session tokens must never be added to
tracked example files.

---

## Implementation checkpoints

Stop and review the completed behavior at these points:

1. After Phase 0: validate the database copy before adding new schema changes.
2. After Phase 2: validate authentication, roles, audits, and semantic keys.
3. After Phase 4: validate MySQL authority and Qdrant eventual synchronization.
4. After Phase 7: validate the complete user workflow before legacy deletion.
5. After Phase 9: final verification and handoff.

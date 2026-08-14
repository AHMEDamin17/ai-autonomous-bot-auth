# Implementation Tracker

Started: 2026-08-03

Specification: `PLAN.md`

Status: **COMPLETE**

## Non-negotiable rules

1. **Qdrant is the final vector database.** Do not introduce Milvus or another
   vector database.
2. **Preserve the existing frontend theme.** Every UI change must reuse the
   project's existing ThemeProvider, design tokens, typography, spacing, surfaces,
   controls, light/dark behavior, responsive breakpoints, and interaction patterns.
   Do not independently restyle the application or introduce arbitrary colors.
3. Preserve existing user changes and unrelated behavior.
4. Never expose credentials, real `.env` values, password material, session tokens,
   database secrets, or provider payloads in code, documentation, logs, or tests.
5. MySQL is the authoritative semantic-model store. Qdrant is a repairable derived
   index.
6. Keep fresh installations on the single `001_init.sql` current-schema baseline;
   do not restore historical create/alter/drop migration chains.
7. Run verification proportional to each change and record the exact result below.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| Baseline | Workspace and theme audit | Complete |
| 0 | Safe `autonomous_db` cutover tooling | Complete |
| 1 | Users, sessions, roles, and profile login | Complete |
| 2 | Audit ownership and semantic keys | Complete |
| 3 | Qdrant and Ollama local infrastructure | Complete |
| 4 | Per-connection model store and vector outbox | Complete |
| 5 | Two-pass incremental generation | Complete |
| 6 | Stable APIs and semantic-catalog separation | Complete |
| 7 | Theme-preserving Semantic Model UI | Complete |
| 8 | Legacy conversion and cleanup | Complete |
| 9 | Full verification and documentation | Complete |

## Completed task

- Consolidated the verified metadata history into one fresh-install baseline,
  removed setup-only schema/code artifacts, required login before rendering the
  application, and made port-3005 conflicts actionable.

## Change log

### 2026-08-03

- Created this tracker before implementation work.
- Locked the existing frontend theme as a mandatory acceptance requirement.
- Confirmed `PLAN.md` is the implementation specification.
- Audited `ThemeContext.jsx`, `theme.json`, `index.css`, and both desktop/mobile
  sidebar implementations.
- Locked the concrete theme baseline: teal primary actions, warm page background,
  white surfaces, CSS-variable text/borders, shared button/card radii and shadows,
  compact semantic-layer typography, and the current responsive sidebar layout.
- Extracted reusable migration execution into `backend/scripts/lib/migrationRunner.ts`.
- Added `backend/scripts/setupAutonomousDb.ts` with read-only preflight, explicit
  execution, safe rerun checks, dependency-ordered copying, audit state, and
  schema/migration/row-count/foreign-key validation.
- Changed the backend default/example metadata DB name to `autonomous_db` and added
  the one-time setup script command.
- Phase 0 execution created and migrated `autonomous_db`, then stopped before data
  copy because migration `012` seeds one empty `semantic_model_doc` row. No source
  data was modified and no source rows were copied. The setup guard is being
  narrowed to recognize only that exact untouched seed before resuming.
- Applied reconciliation migration `014`, copied all 11 application data tables,
  and recorded a completed copy audit. `icon_component_db` was not changed.
- Switched the local backend `.env` to `DB_NAME=autonomous_db` after independent
  verification.
- Added migrations `015_auth_users_sessions.sql` and
  `016_domain_audit_and_semantic_keys.sql` and applied both to `autonomous_db`.
- Implemented versioned salted scrypt password hashing, hashed server-side
  sessions, bounded cleanup, trusted-origin enforcement, login/logout/me/password
  routes, role guards, and final-active-admin protection.
- Added the environment-driven first-admin bootstrap script. No default or
  plaintext password was introduced.
- Added immutable connection semantic keys and backfilled both existing
  connections without changing their credentials or names.
- Added authenticated audit stamping to connection/KPI writes, admin-only
  connection rename support, and owner scoping to both conversation stores.
- Added `AuthProvider`, credentialed API requests, a responsive profile login
  panel, role-aware connection controls, and admin-only name editing while reusing
  the existing theme tokens and component geometry.
- Browser QA found the existing sidebar's `overflow-hidden` clipped the profile
  panel. Changed only that container to `overflow-visible`; the established teal,
  warm background, typography, radii, shadows, and spacing remain unchanged.
- Added a localhost-only Docker Compose stack with Qdrant `v1.18.2`, Ollama
  `0.32.0`, named persistent volumes, container health checks, and an idempotent
  one-shot pull of `nomic-embed-text:v1.5`.
- Added the pinned official Qdrant REST client, validated vector configuration,
  bounded batch embeddings, finite/768-dimension validation, and deterministic
  bounded model summaries.
- Added mismatch-safe Qdrant collection initialization plus model upsert,
  retrieve, delete, and semantic-search functions. Numeric connection IDs are
  used directly as point IDs and payloads retain the full model and stable key.
- Extended readiness reporting with separate MySQL, Redis, Qdrant, and embeddings
  states. Qdrant/Ollama are degradable dependencies and do not make MySQL CRUD
  unavailable.
- Added migration `017_per_connection_semantic_models.sql`: stable semantic keys
  are now non-null, MySQL owns one versioned model row per connection, and a
  FK-independent deduplicated outbox preserves vector deletes after connection
  cascade.
- Added the complete per-connection document schema, safe deterministic datasource
  construction, live table/column/PK checks, expression allowlisting, relationship
  target checks, and field-specific deterministic-edit rejection.
- Added transactional model saves with optimistic revisions, audit stamping,
  generation failure preservation, same-transaction vector enqueue, transactional
  connection-delete enqueue, and explicit retry support.
- Added the leased vector outbox worker with bounded claims, superseded-revision
  protection, capped exponential retry, retained diagnostics, graceful shutdown,
  and conditional completion that cannot erase a newer job.
- Added a semantic-model-specific 10 MiB request limit while preserving the 1 MiB
  global API limit.
- Added a safe Pass-1 application overview using only connection label/type/logical
  scope, selected schema metadata, governed KPI descriptions, and selected foreign
  keys. Hosts, users, secrets, and numeric IDs are excluded from prompts.
- Added one bounded structured Pass-2 call per table, deterministic restoration of
  physical identities/types/PKs, unknown-column rejection, measured-context-only
  wide-table chunk fallback, and hard table/call/time limits.
- Centralized deterministic FK relationship rebuilding and applied it to full,
  append, regenerate, remove, and manual-save paths.
- Added exact-scope generation operations: full replacement, missing-only append,
  one-entity regeneration, and no-LLM removal.
- Added per-connection atomic generation leases, background job ownership,
  previous-model visibility, safe failure messages, overlap rejection, and startup
  recovery for expired/interrupted jobs.
- Moved the existing deterministic analytics catalog to `/api/semantic-catalog`
  and updated the Zustand catalog consumer and temporary legacy combined-document
  calls without changing `buildAiCatalog()` behavior.
- Added the per-connection semantic-model API for read, full/append generation,
  one-table regeneration, body-based table removal, optimistic manual save, and
  vector retry. Read access is shared; all mutations are admin-only.
- Added stable request/status envelopes and `MODEL_BUSY`,
  `STALE_MODEL_REVISION`, `INVALID_SEMANTIC_MODEL`, `UNKNOWN_TABLE`, and safe
  connection-not-found errors without provider payloads/prompts/stacks.
- Rebuilt the Semantic Model tab around the per-connection contracts: live
  table/view selection, full/append controls, per-table regenerate/remove,
  revision-safe JSON review/save, audit/status display, and vector retry.
- Preserved the exact established theme: teal `#0ca1b6`, warm `#f5f4f1`
  background, white surfaces, existing typography/spacing/radii/shadows, shared
  CSS variables, and current desktop/mobile sidebar behavior.
- Browser-verified the admin screen at desktop and 390x844 mobile. The mobile
  document width remained 380px inside a 390px viewport with no horizontal
  overflow. A normal user saw the read-only badge and zero generation, table
  checkbox, add, or save controls. Temporary QA users were removed.
- Added the credential-sanitizing legacy conversion utility and exported a local
  ignored backup plus report. The legacy document contained zero model parts, so
  the gate reported `dropReady: true` without requiring or inventing an audit
  administrator.
- Removed all active combined-document routes, frontend services, startup/reset
  logic, connection-delete hooks, types, queue code, and tests. The deterministic
  analytics catalog remains separately available at `/api/semantic-catalog`.
- Applied migration `018_drop_legacy_semantic_model_doc.sql` after the backup gate.
  Both legacy tables are gone. Cutover verification reports the two real
  connections deliberately at `none` revision 0 until an admin selects tables.
- Added session-expiry, semantic-key collision/rename, audit-stamp, embedding
  dimension/non-finite/timeout, and Qdrant configuration-mismatch coverage plus a
  single `test:implementation` integration bundle.
- Rewrote `WORKFLOW.md` to contain only the current connection and per-connection
  semantic-generation flow, fixed Qdrant/Ollama operation, exact JSON identity
  contract, theme rule, verification, and concrete next steps. Synchronized the
  README, AGENTS guide, complete workflow, and changelog; the analytics
  orchestrator contract was unchanged, so `ORCHESTRATOR_MODES.md` did not need an
  edit.
- Removed six orphaned `model_store_selftest_*` accounts only after verifying they
  had zero connection, KPI, conversation, Dashboard, or semantic-model references.
- Created the requested active `admin` and `user` accounts with their correct roles
  through the project scrypt hashing path. Password material and hashes were not
  written to this tracker or any tracked file.
- Ran the historical audit/ownership backfill against the real `admin` account.
  Final verification found zero missing connection/KPI audit stamps and zero
  missing conversation owners; both requested account passwords verified through
  the application password checker.
- Removed the Summary page, frontend API methods, backend route/generator, OpenAPI
  surface, types, and Summary-specific tests. Analytics AI and Observability are
  active routes and visible semantic-layer tabs.
- Replaced Dashboard connection selection with ready per-connection semantic-model
  routing. The router validates stored semantic JSON and exposes only bounded
  business labels/descriptions to the ranking model.
- Added and applied `019_remove_connection_summaries.sql` after confirming that
  both connection rows contained no non-empty Summary text. The three obsolete
  Summary columns were removed from `db_connections`.
- Renamed active feature modules for clear ownership: `semanticCatalog.ts`,
  `semanticModels.ts`, `semanticModelConnectionRouter.ts`,
  `SemanticModelManager.jsx`, `KpiDefinitions.jsx`, `AnalyticsAssistant.jsx`, and
  `ObservabilityDashboard.jsx`.
- Kept the established navigation/page theme unchanged; the work only restores
  existing tab controls and changes imports/routes/feature ownership.

## Verification log

- `npm.cmd run setup:autonomous-db -- --help` - passed.
- TypeScript no-emit check for the migration runner and Phase 0 scripts - passed.
- Read-only autonomous DB preflight - passed (12 source tables; target absent at
  preflight time).
- Initial autonomous DB execution - safely stopped at the non-empty seed-row guard;
  target audit status recorded as failed for explicit resume.
- Resume reached the transactional copy and rolled it back after detecting live
  schema drift: `kpi_metrics.inclusions` and `kpi_metrics.exclusions` existed in
  `icon_component_db` but not in migrations `001-013`.
- Resumed autonomous copy after migration `014` - passed.
- Independent `--verify-only` schema/migration/row-count/foreign-key validation -
  passed.
- Migration run against `autonomous_db` - passed; migrations `001-014` skipped as
  already applied.
- Backend build - passed.
- Backend active tests - passed: 28 compiler and 102 regression cases.
- Runtime `/healthz` - passed with metadata DB connected.
- Runtime `/readyz` - passed with DB and optional Redis checks ready.
- Authenticated API read against `autonomous_db` - passed; 2 existing connections
  and 0 KPI rows returned without exposing stored connection data.
- Auth/session self-test - passed: valid login and `/me`, admin-only user listing,
  normal-user `403`, forged `X-User-Id` ignored, logout revocation, and subsequent
  `401` were all verified with temporary users that were removed afterward.
- Backend build after Phases 1-2 - passed.
- Backend active tests after Phases 1-2 - passed: 28 compiler and 102 regression
  cases.
- Frontend lint after authentication/connection UI changes - passed.
- Frontend production build after authentication/connection UI changes - passed.
- In-app browser theme QA at the default desktop viewport - passed after fixing
  profile-panel clipping.
- In-app browser responsive theme QA at 390x844 - passed; navigation and login
  panel remain usable and visually consistent.
- Docker Compose configuration validation - passed.
- Qdrant and Ollama containers - healthy; one-shot embedding model initialization
  exited successfully.
- Vector self-test - passed: batch embeddings returned finite 768-dimensional
  vectors; collection creation was idempotent; temporary upsert, retrieve,
  semantic search, and delete all passed.
- Runtime readiness with the full stack - passed (`ready`, all checks healthy).
- Reversible Qdrant outage check - passed: readiness returned HTTP 200
  `degraded`, MySQL stayed healthy, Qdrant reported false, and the service was
  restored afterward.
- Migration `017_per_connection_semantic_models.sql` - applied successfully.
- Model-store integration self-test - passed: invalid live-schema model rejection,
  stale revision `409` behavior, MySQL save during simulated Qdrant outage,
  retained vector diagnostics, explicit retry/repair, failed-generation model
  preservation, and durable Qdrant delete after connection cascade.
- Backend build after Phase 4 - passed.
- Semantic generator integration self-test - passed: exactly three selected tables,
  one overview pass, missing-only append, selected-entity-only regeneration,
  deterministic relationship recomputation, and removal with zero author calls.
- Generation lease integration checks - passed: overlapping job rejected and
  expired job recovered to an error without changing the prior model/revision.
- Backend build after Phase 5 - passed.
- Semantic API integration self-test - passed: user read/admin mutation guards,
  malformed request validation, accepted `202` append job, completion polling,
  unknown-table error, stale `409`, invalid/valid saves, vector retry, table
  removal, and missing-connection response.
- Frontend production build after semantic-catalog URL separation - passed.
- Backend build after Phase 6 - passed.
- Phase 7 frontend lint and production build - passed.
- Phase 7 desktop and 390x844 in-app browser visual QA - passed; established theme
  preserved and mobile overflow absent.
- Phase 7 normal-user browser authorization QA - passed; all write controls absent.
- Legacy conversion backup/verification - passed: 0 legacy parts, 0 unresolved,
  `dropReady: true`.
- Migration 018 and `verify:semantic-cutover` - passed; no legacy tables remain and
  both current connections are deliberately `none`/revision 0/not indexed.
- Full implementation integration bundle - passed: authentication/session expiry
  and revocation, roles/header forgery, semantic keys/audits, vector guards/CRUD/
  search, model store/outbox, incremental generator, semantic APIs, and cutover.
- Final `npm.cmd run test` - passed: 28 compiler + 96 regression cases.
- Final `npm.cmd run build` - passed for backend and frontend.
- Final `npm.cmd run lint` - passed.
- Final `docker compose ps` - passed after permitted Docker API access; Qdrant and
  Ollama are both healthy on localhost.
- Summary-removal backend build - passed.
- Summary-removal active tests - passed: 28 compiler + 96 regression cases.
- Summary-removal full implementation bundle - passed: auth, semantic keys,
  vectors, model store, generator, semantic APIs, and semantic cutover.
- Migration/cutover verification - passed: migrations 018/019 applied, no legacy
  semantic tables, and no Summary columns remain.
- Root backend/frontend production build and frontend lint - passed. Generated
  chunks use the clear names `SemanticModelManager`, `KpiDefinitions`,
  `AnalyticsAssistant`, and `ObservabilityDashboard`.
- OpenAPI runtime inspection - passed: zero `/api/summaries` paths; Analytics and
  Observability paths remain present.
- Desktop browser QA - passed: five expected tabs, no Summary tab, primary
  `#0ca1b6`, background `#f5f4f1`, white surface, and no document overflow.
- Mobile browser QA at 390x844 - passed: no document overflow, all five expected
  tabs remain in the horizontal navigation, and the established responsive shell
  is preserved.
- Direct `/Layer/Summaries` browser check - passed: the retired route falls through
  to the application home route. `/Layer/Observability` still renders the complete
  observability screen.
- Migration/table audit - passed: all operational tables are referenced by active
  authentication, conversation, telemetry, KPI, semantic-model, or vector-outbox
  code. Only `autonomous_copy_audit` was setup-only.
- Fresh baseline self-test - passed: a temporary blank database was created from
  the single `001_init.sql`, verified at exactly 14 runtime tables, and removed.
- Current schema cleanup - completed after destructive prechecks: removed one
  completed copy-audit row/table and the empty unused KPI `inclusions` and
  `exclusions` columns; no KPI row contained legacy values.
- Current migration ledger normalized to only `001_init.sql`; rerunning `migrate`
  skips it cleanly and `verify:schema` reports no missing/unexpected tables or
  obsolete columns.
- Removed obsolete cutover/backfill/legacy-conversion scripts and their package
  commands. Added `verifyCurrentSchema.ts`, `schemaBaselineSelftest.ts`, and the
  shared current-schema contract.
- Added `LoginGate.jsx`; frontend lint and production build pass with the existing
  teal/warm-white theme.
- Port conflict handling reproduced against the already-running nodemon backend:
  a second process exits promptly with an actionable message and no unhandled
  event stack. The existing backend remains healthy on port 3005.
- Full current implementation bundle - passed: fresh-schema baseline,
  authentication, semantic keys, vectors, model store/outbox, generator,
  semantic-model API, and exact current-schema verification.
- Login-gate browser verification - passed on desktop and at 390x844: guests see
  only the theme-preserving sign-in screen, authenticated admin access works, and
  logout returns to the gate without horizontal overflow.
- Final root backend/frontend production build and frontend lint - passed after
  the baseline, login-gate, and startup-error changes.
- Login layout follow-up - passed: fixed the global heading-size override and
  reduced the themed sign-in card from 606px to 419px at 1280x720; the 390x844
  layout is 412px tall with no overflow. Production build and lint pass.
- Port follow-up - completed: stopped the temporary backend process tree used for
  verification and confirmed that no process is listening on port 3005.
- Semantic-layer visibility follow-up - completed: commented out the Analytics AI
  and Observability tab entries, lazy imports, and frontend routes while retaining
  their implementation files and backend APIs.
- Semantic Model presentation follow-up - completed: removed vector/Qdrant state,
  retry/error controls, semantic key, revision, timestamp, and user/audit metadata
  from the UI; retained a compact model status and required connection selector.
- Semantic-layer desktop/mobile QA - passed: navigation contains exactly Database
  Connections, Semantic Models, and KPI Definitions; the compact header has no
  implementation/audit metadata and the 390x844 layout has no horizontal overflow.
- Frontend production build and lint after the visibility/presentation cleanup -
  passed. Observability is absent from the built chunks; Analytics Assistant shared
  result rendering remains because the Dashboard assistant consumes it.
- Semantic generation documentation follow-up - completed: `WORKFLOW.md` now
  identifies `semantic_models.model_json` as the permanent per-connection MySQL
  document and diagrams API acceptance, the overview call, sequential per-table
  calls, backend validation, transactional save, polling, and derived indexing.
- Semantic Model workspace follow-up - completed: moved Semantic JSON directly
  below the connection header and placed the table/view picker beside the Modeled
  Entities panel. Both lists are bounded and independently scrollable.
- Semantic flow source-map follow-up - completed: `WORKFLOW.md` now maps every
  active frontend, route, generation, validation, storage, outbox, embedding, and
  index file to its responsibility; it also distinguishes MySQL runtime records
  and explicit JSON exports from repository source files.

## Historical decisions and assumptions

- Work proceeded in the phase order defined by `PLAN.md`.
- UI implementation did not begin until the existing theme primitives and nearby
  screens have been inspected.
- Local infrastructure downloads and database mutations requiring external
  access/credentials were performed only through the plan's explicit gates.
- Added migration `014_reconcile_kpi_legacy_columns.sql` to preserve the two live
  legacy KPI fields in the target. Authentication and later migrations are
  renumbered to `015-018`; already applied migrations were not renamed.

## Remaining operator action

- None for this implementation. Rotate the initial local account passwords before
  using the application outside an isolated development environment.

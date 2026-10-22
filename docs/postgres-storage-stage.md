# PostgreSQL compatibility storage: stage 2

Historical stage-2 description. Stage 3 now adds 32 normalized tables and embedded PostgreSQL integration checks; see [current table block](database-core-tables.md). The compatibility store remains isolated, and native multi-session PostgreSQL/Render validation remains pending.

Target selected by Alexander on 2026-10-06: PostgreSQL on Render.

## Implemented in this draft

- Read-only JSON/JSONL data preflight.
- Static inventory of 132 JavaScript backend files at one pinned commit.
- Explicit PostgreSQL schema in `migrations/001-document-store.sql`.
- `storage/postgres-document-store.js`, accepting an application-provided PostgreSQL pool.
- One-statement reads of multiple documents; missing revision is `0`, persisted revisions start at `1`.
- Compare-and-set writes for all documents in a batch, in one transaction. A conflict aborts the whole batch. Stable key order limits deadlocks; there is no automatic retry or JSON fallback.
- Values and keys use SQL parameters. Caller values are encoded before asynchronous execution; revisions stay decimal strings to preserve bigint precision.

The compatibility table stores existing parsed JSON structures as JSONB, keyed by exact relative source path. This is an initial SQL storage layer, not the final normalized domain schema. It avoids inventing IDs for legacy records or changing their array order and business rules. Preserve original source files separately: JSONB does not preserve original whitespace, key ordering or duplicate object keys, and raw file hashes cannot validate JSONB bytes. A later importer must compare parsed values and retain source hashes in its migration manifest. JSONL requires a separate mapping; it is not yet imported by this adapter.

## Not wired into production

The server is still entirely on its existing file storage. This draft changes no runtime configuration or npm dependencies, provisions no Render database and performs no import. The schema is explicit and deliberately fails if the schema already exists; do not apply it automatically on startup. A future schema migration runner must track version/checksum and database identity.

The caller must use `readMany` revisions when computing updates and submit all participating documents together in `writeBatch`. Reading values and then performing unconditional writes would reintroduce lost updates. Revision conflicts must return a retriable user-facing conflict or trigger a bounded re-read/recompute, never overwrite blindly. A failed/uncertain COMMIT must not be retried automatically: reconcile the actual database state first. There is no deletion API yet.

## Validation and remaining work

Eight local tests pass: three real filesystem preflight tests and five pool-protocol unit tests. The latter use a test double; they do not validate PostgreSQL parsing, JSONB behavior, transaction rollback or concurrent sessions against a real server. No PostgreSQL server is installed in this execution environment. Real PostgreSQL integration tests are required before wiring the application.

Next: confirm the Render workspace, inspect existing services/database resources, create or select an isolated test database with a concrete plan and region, install `pg` with a lockfile, validate schema and concurrent updates against PostgreSQL, implement a repeatable explicit-allowlist importer with reconciliation, and convert every time-domain reader/writer together. Brain Python access, browser-originated requests, indirect helpers and dynamic paths still need review; the static inventory is not proof of complete coverage.

For Render-hosted app connections use the internal database URL in the same region/workspace. External test connections require verified TLS. Keep connection strings in protected configuration; do not commit them.

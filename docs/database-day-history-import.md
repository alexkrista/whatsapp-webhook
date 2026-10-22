# Imported day workflow history

Migration 011 adds `imported_day_records` and its ordered `imported_day_record_history` children. Four explicit source kinds preserve legacy day closes, releases, corrections and review entries. This archive does not populate active day workflow rows or activate employee confirmations, releases, payroll locks or monthly calculations.

Source IDs, employee/project legacy identities, dates, original status, booleans (including false and absent separately), checks, original timestamps, content and segments are retained. Additional legacy fields remain in immutable source versions. History steps retain order, exact JSON and before/after segments. Missing employee/project mappings retain their source identities with review markers instead of guessing names.

Each normalized archive row is guarded against a mismatched source record/version, company, kind or legacy ID. Archive rows and history are append-only. Repeated imports verify exact originals and target rows; changed source files stop the import for later explicit reconciliation. The importer creates no end-time stamps or payroll rows.

Validation: `TEST/database-day-history-import.pg.cjs` exercises pending versus confirmed states, released and returned together, exact ordered correction/review histories, unresolved identity retention, unchanged replay, source drift rollback, excluded files, tenant mismatch and immutable history. It checks that active day closes, time events, segments, month locks and payroll closures stay empty. PGlite does not exercise real PostgreSQL concurrency.

## Live-Import

Live am 2026-10-07: 1.106 Datensätze erstellt und gelesen/geprüft (78 close, 407 release, 262 correction, 359 review), 669 Historieneinträge geprüft, 13 Zuordnungsprüfungen. Quelldateien nach Import unverändert. Originalbackup `/var/data/_sql-import-originals/day-history-1791379036977`.

# SQL continuation: WinWorker calculation sources, 2026-10-08

Read-only live Render SQL check on 2026-10-08 confirms 245 MB, 21,380 archive metadata rows and 7,080 core WinWorker rows across six tables. All 15 employee-model references are resolved. The latest application deployment is ae19b451; application storage remains JSON. The main migration branch ends at 23dcc76.

PC-ALEX02 isolated read-only exports preserve original column/type/primary-key metadata and exact decimal strings, source timestamps and tagged binary values. Six further available tables were exported:
- Leistungstexte: 3,419 rows
- LohnInfo: 2,243 rows
- LMaterial: 434 rows
- LMaterialIndex: 4,234 rows
- Floskeltexte: 131 rows
- Verzeichnisse: 30 rows
Total 10,491 rows. Export files and checksum manifest are at C:/KRISTINE_WORK/sql-migration-20261008/calculation-export. Existing core exports were not overwritten. No source database writes or permission changes were made.

This bounded importer allows only the complete two-table LohnInfo/Verzeichnisse snapshot (2,273 rows) under its own WinWorker source instance key srv-db01-winworker-standard-calculation. It cannot replace the prior core snapshot. Core/archive imports are rejected against this calculation source; calculation imports are rejected against any other instance before source-version writes. Remaining four exported tables are not yet accepted by this profile.

Original-text transfer package: 1,106,506 bytes, 32,288 bytes gzip; SHA-256 ff1ba8eaa591814b4f8165acdd5eee7ae4f73d2eee648ffd54a5fb402b9fe71d. Explicit operator runner requires this exact package checksum, target database identity and company identity, retains originals, validates every SQL row and repeats the import to prove zero additional projection rows.

Automatic approval review rejected the browser action transferring this new WinWorker package into persistent Render storage because it considered specific source-data/destination authorization missing. The transfer was not retried. This package has NOT been imported into Render SQL. Existing live SQL data is unchanged. Continue only after explicit user authorization for these two tables to the existing kristine-postgres database/Render original archive. No cutover, merge into main, or production deployment is performed by this change.

Obelisk and additional restricted WinWorker databases still need existing read access. Full WinWorker sources, PDF/OCR bytes, ongoing deltas and application readers/writers remain open.

Validation on PC-ALEX02: 63 tests run, 61 passed. The two failing existing filesystem tests require symlink privilege unavailable on this Windows account (EPERM); they are unrelated to the calculation importer. Both external-import tests pass, covering exact quantities, source isolation, complete memberships, A-to-B-to-A replay and transactional rollback. The real two-table export passes importer preflight, with 2,243 and 30 rows and original checksums matching the export manifest. The explicit runner passes node --check. No native multi-session PostgreSQL validation was performed for this new profile.

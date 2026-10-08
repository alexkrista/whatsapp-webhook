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

Automatic approval review rejected the browser action transferring this new WinWorker package into persistent Render storage because it considered specific source-data/destination authorization missing. The transfer was not retried. This was the earlier blocked preparation state; it is superseded by the authorized successful import recorded below. No cutover, merge into main, or production deployment is performed by this change.

Obelisk and additional restricted WinWorker databases still need existing read access. Full WinWorker sources, PDF/OCR bytes, ongoing deltas and application readers/writers remain open.

Validation on PC-ALEX02: 63 tests run, 61 passed. The two failing existing filesystem tests require symlink privilege unavailable on this Windows account (EPERM); they are unrelated to the calculation importer. Both external-import tests pass, covering exact quantities, source isolation, complete memberships, A-to-B-to-A replay and transactional rollback. The real two-table export passes importer preflight, with 2,243 and 30 rows and original checksums matching the export manifest. The explicit runner passes node --check. No native multi-session PostgreSQL validation was performed for this new profile.

## Authorized live import completed, 2026-10-08 10:27:57 UTC

Alexander explicitly authorized the two-table package and original files to the existing Render kristine-postgres database in this chat. The previously rejected transfer was retried only after that authorization. Package checksum and all four downloaded import-code checksums matched the pinned GitHub commit de21e18b7279cf58b8d67538eeebfc8b6a743d06 before execution.

Source instance b5cce219-3304-4464-8c29-26f2c5e04e7d. First domain run 8687963e-ae41-45f0-a23c-cc8d9f1867aa: 2 files, 2,273 rows created and fully verified (LohnInfo 2,243; Verzeichnisse 30). Original snapshot run bc2065fa-698d-4127-8e58-2ed74234cb73: 2 new original versions, 961,996 bytes, 0 parsing review. Repeat domain run 625f0ae0-e011-44b5-8123-7e65a816d345: 2,273 rows verified, 0 rows created. Repeat snapshot 6e1fe48c-443c-4b4f-aecd-6569da106faf: 0 versions created, 2 unchanged.

Exact original backup and complete result.json: /var/data/_sql-import-originals/calculation-import-1791455274369. Transfer package and execution log remain alongside it. Independent read-only SQL count after completion: 21,380 archive rows; core WW Adressen 2,129 and Projekte 4,951 remain present; calculation sources 2,273. Total staged WinWorker rows now 9,353. Database size 247 MB. The source instance separates this profile from the six-table core snapshot and prevents replacing its latest membership. No production application reader/writer or JSON cutover was performed. Four larger exported calculation tables remain pending; they are not included in this authorization or this completed import.

## Performance/material follow-up

User authorized four additional source tables in the existing Render database: Leistungstexte 3419, LMaterial 434, LMaterialIndex 4234, Floskeltexte 131 (8218 total). Exact originals verified against export checksums; real four-file preflight passed. Separate source key srv-db01-winworker-standard-performance-material preserves the core and prior calculation snapshots. Three targeted PostgreSQL import tests passed, covering repeats, source boundaries, incomplete sets and rollback. Package SHA-256: 11636c03d40f0540a600c67068c35ab62efd9db0e4a80d2f215d612fc9aed798. Live import pending package transfer verification. No main merge or production cutover.

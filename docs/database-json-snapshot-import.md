# Complete business JSON source staging

This stage copies exact UTF-8 JSON and JSONL text into immutable `source_record_versions` under `json_file_snapshot`, with a separate manifest recording membership and SHA-256 per path. It does not switch the application to SQL or populate all normalized business tables.

A repeated unchanged file is verified without duplication. A changed file adds a new immutable version. Identical JSONL rows are retained. Invalid JSON is retained as exact text and marked for review rather than silently discarded. Original text is authoritative, including large numeric literals and original formatting.

Only an explicitly inventoried business-file list is passed to the importer. Runtime credentials, tokens, login challenges, browser sessions, customer access credentials, node modules, `_sql-import-originals` and backup directories are excluded. Business histories such as deleted Regie reports and WinWorker cache retain their paths and are not merged into active records. Files containing zero bytes or invalid UTF-8 stop the importer. Binary attachments are a separate document migration.

Live files continue to change while JSON remains authoritative. Each run has a manifest; filesystem hashes and membership must be compared after the run, and changes recorded as pending reconciliation. A file-by-file capture is not a single atomic filesystem snapshot. Never call it a completed SQL cutover or a complete WinWorker/Obelisk import: external archives still require their own source inventory.

No API secret or production data belongs in GitHub. Source file contents remain inside the Render service and database. Originals are copied into a private hash-addressed backup before database writes. The import uses one transaction with a source-instance lock and verifies the exact readback for every file. Existing normalized time data and payroll snapshots are untouched.

Validation: `TEST/database-json-snapshot-import.pg.cjs` covers exact original readback, large integers, duplicate JSONL rows, malformed JSON preservation, unchanged replay, append-only changed versions, immutable originals, tenant mismatch rollback and credential/path exclusions. PGlite does not validate real PostgreSQL concurrency.

Ronnys archive correction on 2026-10-07 preserved both original SQL source versions, created two new versions on their existing day source records, removed the false final start at 17:06 on 2026-07-29, and completed the 2026-08-20 block at 17:00. Active JSON and SQL archive blocks were independently compared. Normalized immutable SQL time events still preserve the original import, and the strict original time importer must not be blindly rerun after source corrections.

## Live result 2026-10-07

939 selected business JSON/JSONL files, 81,525,991 bytes, were imported and exact SQL readback verified. No malformed files were found. Run `d991508a-44a0-4bc4-89a9-7a90adc7938f`, manifest `c1e492531691b5b0f5ec9ee674bb51ea30b66906f768f1773253d11db496cb19`. Three files changed during capture/import and are pending later reconciliation; no new selected paths appeared. The private source copy and manifest are under `/var/data/_sql-import-originals/json-snapshot-1791377898970`. This covers the available Render business JSON sources, including cached WinWorker files; it does not establish completeness of external WinWorker/Obelisk archives or separate binary files.

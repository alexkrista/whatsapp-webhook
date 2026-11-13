# JSON to PostgreSQL migration

Alexander selected PostgreSQL on Render on 2026-10-06.

- [Storage stage and remaining work](postgres-storage-stage.md)
- [Pinned access inventory](json-storage-inventory.md)
- [Full static evidence](json-storage-inventory.json)

Run the read-only preflight against a trusted, quiesced copy of DATA_DIR:

    node tools/sql-migration-audit.js /path/to/data-copy > /path/outside-data/audit.json

Output omits payloads and contains relative filenames, byte counts, SHA-256, top-level shape/count and validation flags. Object counts are top-level keys, not domain record counts. Invalid JSON/JSONL/UTF-8, detected changes, symlinks and empty sources fail preflight. PDFs/photos are excluded. Backup JSON is included: this inventory is not an import allowlist.

ready means only that the inventory passed validation. consistentSnapshot remains false: independent file reads cannot prove a cross-file snapshot. Use a quiesced copy for import. This is not a filesystem security boundary, and files are read individually into memory.

No runtime storage switch, database provisioning, live import or deployment has occurred. The PostgreSQL schema and pool-based adapter are isolated foundations; real-server integration and complete ownership mapping remain prerequisites.

Validation: eight local tests (three filesystem tests, five pool-protocol tests using a double).

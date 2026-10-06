# JSON to SQL: phase 1

Baseline inspected: dcbcb525c0d03942314ce4da8bfaa3d843a949fd.

This phase adds only an explicit, read-only inventory command. It does not change server startup, install a SQL driver, connect to a database, or migrate production data.

## Observed storage

- kristine.js: assignments, states, tasks, time-events, day-review-entries, day-corrections, day-releases, day-controls, project-time-archive and worktime-models.
- day-close.js: day-closes plus shared time-events, states, tasks and regie-reports; project metadata is read from job/.meta.json.
- contact-master.js: _kristine/contact-master.json with temporary-file replacement.
- events.jsonl is also part of the source inventory.

Direct file access exists in multiple modules. A storage wrapper in one module alone will not switch all readers and writers. A complete repository-wide access inventory is still required.

## Command

Run against a trusted, quiesced copy of DATA_DIR:

    node tools/sql-migration-audit.js /path/to/data-copy > /path/outside-data/audit.json

Output contains relative filenames, byte counts, SHA-256, top-level shape/count and validation flags; it omits payloads and exception details. Object counts mean top-level keys, not domain record counts. JSONL counts mean nonempty valid lines. Files with invalid UTF-8, invalid JSON, detected concurrent changes, symlinks or an empty source fail preflight. Other file types are excluded; PDFs and photos need their own backup verification. All JSON is inventoried, including backups: this is not an import allowlist.

ready means this inventory passed validation. It never authorizes a production switch. consistentSnapshot is always false because independent file reads cannot prove a transaction-consistent cross-file snapshot. Use a quiesced backup for actual import. The command is not a filesystem security boundary; use only a trusted source tree. Files are read into memory individually, so size capacity needs checking before running against large archives.

## Next implementation stages

1. Confirm SQL engine and environment; PostgreSQL is a candidate, not an established decision.
2. Map every source and reader/writer; define stable identities and transaction boundaries. Do not change time calculation rules as part of storage migration.
3. Build SQL schema and a repeatable importer against the verified backup. Preserve original identifiers and source hashes; reconcile counts and values.
4. Move a complete bounded domain behind the storage interface. Validate concurrent writes, restarts and rollback using a test instance.
5. Quiesce writes, import final data, reconcile and switch all domain readers and writers together. Avoid uncoordinated JSON/SQL dual writes. Keep original files as a rollback snapshot with a documented procedure for handling writes after cutover.

Validation: node --test TEST/sql-migration-audit.test.js (three tests). Production inventory and SQL integration tests remain pending.

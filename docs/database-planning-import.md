# Planning and absence source import

Migration 010 adds source record/version references and exact original time fields to the existing assignments and absences tables. UUID employee and project references are resolved only through prior source ID mappings. Unresolved employees stop the transaction; unresolved legacy projects are retained with a review flag. Special project codes such as `__feiertag__` are retained and used as activity codes, not invented projects.

Both complete valid planning times are stored as SQL time values. Incomplete or invalid pairs retain the original values and are flagged; neither endpoint is guessed. Planned/reported hours retain the original value and are never converted to actual working time or payroll. Each absence source row is retained, including identical duplicates. Full source files and individual rows are archived exactly; replay verifies existing targets, changed sources require an explicit reconciliation.

The application remains on JSON. This import sends no messages, creates no live time segments and changes no payroll closures. Use a temporary importer with one connection and preserve/read back private originals before the import. Migration execution is explicit; no startup hook.

Validation: `TEST/database-planning-import.pg.cjs` tests partial time preservation, unknown projects, holiday codes, duplicate absences, unchanged replay, changed-source rollback, unknown employees, target corruption and zero live time segments. PGlite does not validate real PostgreSQL concurrency.

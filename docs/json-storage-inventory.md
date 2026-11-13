# JSON storage access inventory

Baseline: `dcbcb525c0d03942314ce4da8bfaa3d843a949fd`.

132 JavaScript backend files inspected. Python Brain services and browser code are not included. Literal references and filesystem calls are heuristic evidence, not a complete data-flow or runtime inventory. Reused basenames can refer to different directories; computed filenames and injected helpers require manual review.

## Time-domain references

| Source filename | Referencing modules |
|---|---|
| `time-events.json` | `access-bridge-cloud.js:118`, `archive-search.js:11`, `daily-report.js:24`, `day-close.js:18`, `job-merge-audit.js:21`, `kgo-office-core.js:74`, `kgo-office-preload.js:19`, `kgo-office-whatsapp.js:123`, `kristine.js:20`, `morning-status.js:886`, `photo-inbox.js:20`, `photo-inbox.js:68`, `regie-assistant.js:27`, `server.js:1505`, `server.js:3774`, `server.js:4767`, `tower-planning.js:165` |
| `states.json` | `day-close.js:19`, `kristine.js:17`, `morning-status.js:887` |
| `assignments.json` | `daily-report.js:27`, `kristine-shared-calendar.js:193`, `kristine.js:16`, `morning-status.js:884`, `regie-assistant.js:29`, `server.js:495`, `server.js:2118`, `server.js:3378`, `server.js:3773` |
| `day-closes.json` | `day-close.js:17`, `morning-status.js:888` |
| `day-review-entries.json` | `daily-report.js:25`, `job-merge-audit.js:18`, `kristine.js:21`, `legacy-collection-repair.js:41`, `photo-inbox.js:20`, `photo-inbox.js:43`, `photo-inbox.js:68`, `regie-assistant.js:33`, `server.js:1475`, `server.js:1476` |
| `day-corrections.json` | `kristine.js:24` |
| `day-releases.json` | `kristine.js:25` |
| `day-controls.json` | `kristine.js:26` |
| `project-time-archive.json` | `job-merge-audit.js:22`, `kristine.js:28`, `regie-assistant.js:28` |
| `tasks.json` | `day-close.js:20`, `kristine-outlook-calendar.js:22`, `kristine-user-access.js:59`, `kristine.js:18`, `nfon-integration.js:93`, `paint-goods-receipt.js:7`, `paint-mix-history.js:18`, `photo-inbox.js:52`, `regie-assistant.js:34`, `server.js:471`, `server.js:474`, `server.js:475`, `server.js:486`, `server.js:494`, `task-digest.js:244` |
| `regie-reports.json` | `day-close.js:21`, `regie-assistant.js:25` |
| `employees.json` | `access-admin-cloud.js:16`, `access-admin-cloud.js:16`, `archive-search.js:15`, `daily-report.js:28`, `daily-report.js:29`, `employee-sessions.js:33`, `kgo-office-preload.js:18`, `krisdrive-logbook.js:461`, `paint-goods-receipt.js:18`, `paint-mix-history.js:19`, `photo-inbox.js:52`, `photo-inbox.js:75`, `regie-assistant.js:30`, `regie-assistant.js:31`, `server.js:4025`, `vehicle-tracking.js:22` |

## Storage findings

- `day-close.js` writes a day-close record but explicitly does not generate an end-of-work time event. Keep this behavior during migration.
- `kristine.js` truncates time events to the last 20,000 entries in several write paths. A SQL migration cannot recover older events absent from JSON; inspect archives and backups before assessing historical completeness. Do not silently change retention in the storage PR.
- `_system/employees.json` and `_kristine/employees.json` both appear. They must retain separate source identities until ownership is resolved.
- `kgo-office-core.js` writes shared time-events, in addition to the main Kristine writers. An adapter in Kristine alone is insufficient.
- Monthly release/detachment logic spans time-events, project-time-archive, releases and controls. Group participating changes into one database transaction while preserving existing rules.
- Backup files are excluded from code scanning, but the data preflight inventories all JSON including backups. Select an explicit import allowlist after mapping paths.

## Coverage

Found 127 distinct JSON/JSONL literal strings and 422 filesystem-call lines. Full evidence is in `json-storage-inventory.json`. All 132 source files were retrieved successfully at the baseline commit. Actual runtime paths, indirect calls, Python access and live data reconciliation remain pending.

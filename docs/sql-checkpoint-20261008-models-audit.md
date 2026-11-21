# SQL checkpoint: company models and audit sources

Checked 2026-10-08 02:43 UTC. Production remains JSON; no merge, deployment, or cutover.

Company-model snapshot: 4 files, 39,434 bytes, all existing versions reused, exact original text/hash/metadata readback passed. Seven worktime models and three schedule models in each of the distinct _system and _kristine files; paint settings also checked. Run 97db89fe-1fc2-44e0-95e3-b0410a047449; repeat 83d80fe9-6501-48fb-bf3d-e8f8f82774d8 created zero versions. Backup /var/data/_sql-import-originals/company-models-1791427398146.

Audit snapshot: 3 files, 9,158,082 bytes, two new versions and one reused. _kristine/events.jsonl: 1,910 entries; vehicle-tracking/events.jsonl: 1,295; outlook-calendar.jsonl: 55,523. Total 58,728 entries. All JSONL parsed, exact original readback passed; repeat created zero versions. Run 5d9d8056-374c-4759-a30a-e5e098add302; repeat 538a3c2d-7ef9-4007-a1ff-a4d3f1cbe67f. Backup /var/data/_sql-import-originals/event-audit-1791427426808.

Both captures had zero changed files at the immediate post-import check. This is a bounded snapshot, not ongoing synchronization. Existing import-json-snapshots.js from commit 1fb199692351340925acbf8c4fc2582d94d8d25f was downloaded and SHA-256 verified before execution. This checkpoint adds no typed domain tables, application readers, payroll activation, vehicle commands, or calendar operations. Separate schedule sources remain separate. Structured company-rule/audit integration, final reconciliation, unresolved mappings, and external archive completeness remain open.

# Regie and delivery note source archive

Migration 012 preserves original report states in `imported_regie_reports`, with ordered people, materials and attachment children. The legacy people list and priced employee list remain separate collections. Report IDs and numbers are retained; project/employee UUIDs use source ID mappings only. Unknown IDs retain their original identity with review markers.

Original report totals, hourly rates, discounts and material prices are copied as arbitrary precision decimal values without floating point recalculation. Missing prices remain null; an explicit zero is retained as a free price. Document type, processing/review/billing states and pending-price flag remain as originally recorded. Employee blocks, per-item overrides, signatures and every additional field remain in immutable source versions/child payloads. No status is inferred to mean approved or paid.

The archive does not create new invoices, stock movements, signatures, approvals, document links or deliveries. Binary files are indexed in the separate document migration. The active JSON source file remains authoritative until reconciliation and cutover. Original text is preserved, changes require explicit reconciliation, replay verifies targets, and archive rows/children are immutable.

Validation: `TEST/database-regie-import.pg.cjs` covers arbitrary precision amounts, leading-zero report numbers, explicit free price versus unknown price, 100 percent discounts, unchanged replay, raw employee blocks/attachments, original prepared delivery note state, append-only children and source drift rollback. Active reports, outgoing invoices and stock movements remain empty. PGlite does not exercise real PostgreSQL concurrency.

## Live-Import

Live am 2026-10-07: 72 Berichte, 232 Mitarbeitereinträge, 139 Materialpositionen und 128 Anhangseinträge erstellt und geprüft; Quelldatei unverändert. Originalbackup `/var/data/_sql-import-originals/regie-1791379656817`.

BEGIN;

CREATE OR REPLACE VIEW kristine.job_hour_facts_v1 AS
SELECT
  j.job_no,
  j.name,
  j.status,
  COALESCE(b.fixed_target_minutes, 0)::bigint AS fixed_target_minutes,
  COALESCE(b.planned_regie_minutes, 0)::bigint AS planned_regie_minutes,
  (COALESCE(b.fixed_target_minutes, 0) + COALESCE(b.planned_regie_minutes, 0))::bigint AS total_target_minutes,
  COALESCE(SUM(ws.duration_minutes) FILTER (WHERE ws.billing_type = 'order'), 0)::bigint AS actual_order_minutes,
  COALESCE(SUM(ws.duration_minutes) FILTER (WHERE ws.billing_type = 'regie'), 0)::bigint AS actual_regie_minutes,
  COALESCE(SUM(ws.duration_minutes), 0)::bigint AS actual_total_minutes
FROM kristine.jobs j
LEFT JOIN kristine.job_budgets b ON b.job_no = j.job_no
LEFT JOIN kristine.work_segments ws ON ws.job_no = j.job_no
GROUP BY j.job_no, j.name, j.status, b.fixed_target_minutes, b.planned_regie_minutes;

CREATE OR REPLACE VIEW kristine.job_hour_summary_v1 AS
SELECT
  f.*,
  GREATEST(f.total_target_minutes - f.actual_total_minutes, 0)::bigint AS remaining_total_minutes,
  GREATEST(f.fixed_target_minutes - f.actual_order_minutes, 0)::bigint AS remaining_order_minutes,
  GREATEST(f.planned_regie_minutes - f.actual_regie_minutes, 0)::bigint AS remaining_regie_minutes,
  CASE
    WHEN f.status = 'Auftrag' THEN f.total_target_minutes
    WHEN f.status = 'Laufend' THEN GREATEST(f.total_target_minutes - f.actual_total_minutes, 0)
    ELSE 0
  END::bigint AS open_portfolio_minutes,
  'Auftrag=Soll; Laufend=max(Soll-Ist,0); sonst=0'::text AS policy_v1
FROM kristine.job_hour_facts_v1 f;

CREATE OR REPLACE VIEW kristine.collection_hour_summary_v1 AS
SELECT
  c.collection_no,
  c.name,
  c.status,
  COUNT(m.job_no)::bigint AS member_count,
  COALESCE(SUM(h.fixed_target_minutes), 0)::bigint AS fixed_target_minutes,
  COALESCE(SUM(h.planned_regie_minutes), 0)::bigint AS planned_regie_minutes,
  COALESCE(SUM(h.total_target_minutes), 0)::bigint AS total_target_minutes,
  COALESCE(SUM(h.actual_order_minutes), 0)::bigint AS actual_order_minutes,
  COALESCE(SUM(h.actual_regie_minutes), 0)::bigint AS actual_regie_minutes,
  COALESCE(SUM(h.actual_total_minutes), 0)::bigint AS actual_total_minutes,
  CASE
    WHEN c.status = 'Auftrag' THEN COALESCE(SUM(h.total_target_minutes), 0)
    WHEN c.status = 'Laufend' THEN GREATEST(
      COALESCE(SUM(h.total_target_minutes), 0) - COALESCE(SUM(h.actual_total_minutes), 0),
      0
    )
    ELSE 0
  END::bigint AS open_portfolio_minutes
FROM kristine.job_collections c
LEFT JOIN kristine.job_collection_members m ON m.collection_no = c.collection_no
LEFT JOIN kristine.job_hour_summary_v1 h ON h.job_no = m.job_no
GROUP BY c.collection_no, c.name, c.status;

-- Genau eine Zeile je sichtbarer Einheit: Sammelmappen plus nicht zugeordnete
-- Einzelbaustellen. Dadurch können Mitglieder nie doppelt in die Summe fallen.
CREATE OR REPLACE VIEW kristine.portfolio_hour_rows_v1 AS
SELECT
  ('collection:' || c.collection_no)::text AS portfolio_key,
  c.collection_no AS display_no,
  c.name,
  c.status,
  c.total_target_minutes,
  c.actual_total_minutes,
  c.open_portfolio_minutes,
  'collection'::text AS row_type
FROM kristine.collection_hour_summary_v1 c
UNION ALL
SELECT
  ('job:' || h.job_no)::text AS portfolio_key,
  h.job_no AS display_no,
  h.name,
  h.status,
  h.total_target_minutes,
  h.actual_total_minutes,
  h.open_portfolio_minutes,
  'job'::text AS row_type
FROM kristine.job_hour_summary_v1 h
WHERE NOT EXISTS (
  SELECT 1 FROM kristine.job_collection_members m WHERE m.job_no = h.job_no
);

CREATE OR REPLACE VIEW kristine.portfolio_hour_kpi_v1 AS
SELECT
  COALESCE(SUM(open_portfolio_minutes), 0)::bigint AS open_portfolio_minutes,
  ROUND(COALESCE(SUM(open_portfolio_minutes), 0)::numeric / 60, 2) AS open_portfolio_hours,
  COUNT(*) FILTER (WHERE open_portfolio_minutes > 0)::bigint AS contributing_rows,
  'hours-policy-v1'::text AS calculation_version
FROM kristine.portfolio_hour_rows_v1;

INSERT INTO kristine.schema_migrations (version, description)
VALUES ('002', 'Canonical job, collection and portfolio hour views v1')
ON CONFLICT (version) DO NOTHING;

COMMIT;

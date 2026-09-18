-- Kontrolle 1: vollständige Herleitung jeder sichtbaren Baustellenzeile.
SELECT
  display_no,
  name,
  status,
  row_type,
  ROUND(total_target_minutes::numeric / 60, 2) AS target_hours,
  ROUND(actual_total_minutes::numeric / 60, 2) AS actual_hours,
  ROUND(open_remaining_active_minutes::numeric / 60, 2) AS remaining_active_hours,
  ROUND(open_committed_minutes::numeric / 60, 2) AS committed_open_hours
FROM kristine.portfolio_hour_rows_v1
ORDER BY open_remaining_active_minutes DESC, display_no;

-- Kontrolle 2: beide Kandidaten nebeneinander; erst danach wird einer freigegeben.
SELECT * FROM kristine.portfolio_hour_kpi_candidates_v1;

-- Kontrolle 3: keine Einzelbaustelle darf in mehreren Sammelmappen stecken.
SELECT job_no, COUNT(*) AS collection_count
FROM kristine.job_collection_members
GROUP BY job_no
HAVING COUNT(*) > 1;

-- Kontrolle 4: keine verwaisten oder zeitlich unplausiblen Stunden.
SELECT ws.id, ws.source_system, ws.source_key, ws.job_no, ws.work_date,
       ws.started_at, ws.ended_at, ws.duration_minutes
FROM kristine.work_segments ws
LEFT JOIN kristine.jobs j ON j.job_no = ws.job_no
WHERE j.job_no IS NULL
   OR ws.duration_minutes <= 0
   OR ws.duration_minutes > 24 * 60
   OR (ws.started_at IS NOT NULL AND ws.ended_at IS NOT NULL AND ws.ended_at <= ws.started_at);

-- Kontrolle 5: doppelte Herkunftsschlüssel wären ein Importfehler.
SELECT source_system, source_key, COUNT(*) AS duplicate_count
FROM kristine.work_segments
GROUP BY source_system, source_key
HAVING COUNT(*) > 1;

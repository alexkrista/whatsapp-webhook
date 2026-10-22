BEGIN;
-- Legacy employee model IDs may name worktime models OR retained schedule models.
-- Only a single exact source-scoped candidate resolves; no name/fallback inference.
CREATE VIEW kristine.latest_employee_rule_model_links AS
SELECT p.company_id,p.source_instance_id,p.source_version_id AS employee_source_version_id,p.position AS employee_position,
 p.legacy_id AS legacy_employee_id,p.worktime_model_id_original,
 c.candidate_count,
 CASE WHEN NULLIF(p.worktime_model_id_original,'') IS NULL THEN 'unassigned' WHEN c.candidate_count=0 THEN 'unresolved' WHEN c.candidate_count=1 THEN 'resolved' ELSE 'ambiguous' END AS resolution_status,
 CASE WHEN c.candidate_count=1 THEN c.paths[1] END AS resolved_model_source_path,
 CASE WHEN c.candidate_count=1 THEN c.versions[1] END AS resolved_model_source_version_id,
 CASE WHEN c.candidate_count=1 THEN c.positions[1] END AS resolved_model_position,
 COALESCE(c.candidates,'[]'::jsonb) AS exact_candidates
FROM kristine.latest_imported_employee_profiles p
CROSS JOIN LATERAL (
 SELECT count(*)::int candidate_count,array_agg(m.source_path ORDER BY m.source_path,m.model_position) paths,
 array_agg(m.source_version_id ORDER BY m.source_path,m.model_position) versions,array_agg(m.model_position ORDER BY m.source_path,m.model_position) positions,
 jsonb_agg(jsonb_build_object('sourcePath',m.source_path,'sourceVersionId',m.source_version_id,'position',m.model_position,'legacyId',m.legacy_id) ORDER BY m.source_path,m.model_position) candidates
 FROM kristine.latest_company_rule_models m WHERE m.company_id=p.company_id AND m.source_instance_id=p.source_instance_id AND m.legacy_id=NULLIF(p.worktime_model_id_original,'')
) c;
COMMIT;

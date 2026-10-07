BEGIN;
CREATE VIEW kristine.resolved_imported_day_records AS
 SELECT e.*,coalesce(e.project_id,x.project_id) AS resolved_project_id,
 (e.legacy_project_id IS NOT NULL AND coalesce(e.project_id,x.project_id) IS NULL) AS project_reference_unresolved
 FROM kristine.latest_imported_day_records e
 LEFT JOIN kristine.source_records s ON s.company_id=e.company_id AND s.source_instance_id=e.source_instance_id AND s.entity_type='project' AND s.external_id=e.legacy_project_id
 LEFT JOIN kristine.external_references x ON x.company_id=s.company_id AND x.source_record_id=s.id;
CREATE VIEW kristine.resolved_imported_time_events AS
 SELECT e.*,coalesce(e.project_id,x.project_id) AS resolved_project_id,
 (e.legacy_project_id IS NOT NULL AND coalesce(e.project_id,x.project_id) IS NULL) AS project_reference_unresolved
 FROM kristine.latest_imported_time_events e
 LEFT JOIN kristine.source_records s ON s.company_id=e.company_id AND s.source_instance_id=e.source_instance_id AND s.entity_type='project' AND s.external_id=e.legacy_project_id
 LEFT JOIN kristine.external_references x ON x.company_id=s.company_id AND x.source_record_id=s.id;
CREATE VIEW kristine.resolved_imported_archive_segments AS
 SELECT e.*,d.source_instance_id,d.reconciliation_run_id,
 coalesce(e.project_id,x.project_id) AS resolved_project_id,
 (e.legacy_project_id IS NOT NULL AND coalesce(e.project_id,x.project_id) IS NULL) AS project_reference_unresolved
 FROM kristine.project_time_archive_segment_versions e
 JOIN kristine.latest_imported_archive_days d ON d.company_id=e.company_id AND d.id=e.day_id
 LEFT JOIN kristine.source_records s ON s.company_id=e.company_id AND s.source_instance_id=d.source_instance_id AND s.entity_type='project' AND s.external_id=e.legacy_project_id
 LEFT JOIN kristine.external_references x ON x.company_id=s.company_id AND x.source_record_id=s.id;
COMMIT;

BEGIN;
CREATE TABLE kristine.project_time_archive_day_versions
 (LIKE kristine.project_time_archive_days INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE kristine.project_time_archive_day_versions ADD PRIMARY KEY(id), ADD UNIQUE(company_id,id),
 ADD UNIQUE(company_id,source_record_id,source_version_id),
 ADD FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
 ADD FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 ADD FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id);
CREATE TABLE kristine.project_time_archive_segment_versions
 (LIKE kristine.project_time_archive_segments INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE kristine.project_time_archive_segment_versions ADD PRIMARY KEY(day_id,position),
 ADD FOREIGN KEY(company_id,day_id) REFERENCES kristine.project_time_archive_day_versions(company_id,id),
 ADD FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id);
CREATE TABLE kristine.time_reconciliation_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id uuid NOT NULL, source_instance_id uuid NOT NULL, import_run_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id),
 UNIQUE(company_id,source_instance_id,import_run_id)
);
CREATE TABLE kristine.time_reconciliation_events (
 company_id uuid NOT NULL, source_instance_id uuid NOT NULL, import_run_id uuid NOT NULL,
 source_record_id uuid NOT NULL, time_event_id uuid NOT NULL,
 PRIMARY KEY(import_run_id,source_record_id), UNIQUE(import_run_id,time_event_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.time_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,source_instance_id,source_record_id) REFERENCES kristine.source_records(company_id,source_instance_id,id),
 FOREIGN KEY(company_id,time_event_id) REFERENCES kristine.time_events(company_id,id)
);
CREATE TABLE kristine.time_reconciliation_days (
 company_id uuid NOT NULL, source_instance_id uuid NOT NULL, import_run_id uuid NOT NULL,
 day_id uuid NOT NULL, PRIMARY KEY(import_run_id,day_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.time_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,day_id) REFERENCES kristine.project_time_archive_day_versions(company_id,id)
);
CREATE FUNCTION kristine.guard_archive_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.id=NEW.source_record_id
 AND s.entity_type='project_time_archive_day' AND s.external_id=NEW.legacy_id)
 THEN RAISE EXCEPTION 'Archive source mismatch'; END IF; RETURN NEW;
END $$;
CREATE FUNCTION kristine.guard_time_reconciliation_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='time_reconciliation_events' THEN
  IF NOT EXISTS(SELECT 1 FROM kristine.external_references x JOIN kristine.source_records s ON s.id=x.source_record_id AND s.company_id=x.company_id
   WHERE x.company_id=NEW.company_id AND x.source_record_id=NEW.source_record_id AND x.time_event_id=NEW.time_event_id
   AND s.source_instance_id=NEW.source_instance_id AND s.entity_type='time_event')
  THEN RAISE EXCEPTION 'Time event source mismatch'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM kristine.project_time_archive_day_versions d JOIN kristine.source_records s ON s.id=d.source_record_id AND s.company_id=d.company_id
   WHERE d.company_id=NEW.company_id AND d.id=NEW.day_id AND s.source_instance_id=NEW.source_instance_id)
  THEN RAISE EXCEPTION 'Archive membership source mismatch'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER archive_version_source_guard BEFORE INSERT ON kristine.project_time_archive_day_versions FOR EACH ROW EXECUTE FUNCTION kristine.guard_archive_version();
CREATE TRIGGER event_membership_guard BEFORE INSERT ON kristine.time_reconciliation_events FOR EACH ROW EXECUTE FUNCTION kristine.guard_time_reconciliation_member();
CREATE TRIGGER day_membership_guard BEFORE INSERT ON kristine.time_reconciliation_days FOR EACH ROW EXECUTE FUNCTION kristine.guard_time_reconciliation_member();
CREATE VIEW kristine.latest_time_reconciliation_runs AS
 SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id
 FROM kristine.time_reconciliation_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id
 WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC;
CREATE VIEW kristine.latest_imported_time_events AS
 SELECT e.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id
 FROM kristine.latest_time_reconciliation_runs l JOIN kristine.time_reconciliation_events m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.time_events e ON e.company_id=m.company_id AND e.id=m.time_event_id;
CREATE VIEW kristine.latest_imported_archive_days AS
 SELECT d.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id
 FROM kristine.latest_time_reconciliation_runs l JOIN kristine.time_reconciliation_days m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.project_time_archive_day_versions d ON d.company_id=m.company_id AND d.id=m.day_id;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['project_time_archive_day_versions','project_time_archive_segment_versions','time_reconciliation_runs','time_reconciliation_events','time_reconciliation_days'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t);
 END LOOP;
END $$;
COMMIT;

BEGIN;
-- Append-only typed day revisions. Baseline tables and production JSON stay intact.
CREATE TABLE kristine.imported_day_record_versions
 (LIKE kristine.imported_day_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE kristine.imported_day_record_versions
 ADD PRIMARY KEY(id), ADD UNIQUE(company_id,id),
 ADD UNIQUE(company_id,source_record_id,source_version_id),
 ADD FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
 ADD FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
 ADD FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 ADD FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id);
CREATE TABLE kristine.imported_day_record_version_history
 (LIKE kristine.imported_day_record_history INCLUDING CONSTRAINTS);
ALTER TABLE kristine.imported_day_record_version_history ADD PRIMARY KEY(day_record_id,position),
 ADD FOREIGN KEY(company_id,day_record_id) REFERENCES kristine.imported_day_record_versions(company_id,id);
CREATE TABLE kristine.day_reconciliation_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id uuid NOT NULL, source_instance_id uuid NOT NULL, import_run_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(company_id,source_instance_id,import_run_id)
  REFERENCES kristine.import_runs(company_id,source_instance_id,id),
 UNIQUE(company_id,source_instance_id,import_run_id)
);
CREATE TABLE kristine.day_reconciliation_members (
 company_id uuid NOT NULL, source_instance_id uuid NOT NULL, import_run_id uuid NOT NULL,
 day_record_id uuid NOT NULL, PRIMARY KEY(import_run_id,day_record_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id)
  REFERENCES kristine.day_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,day_record_id) REFERENCES kristine.imported_day_record_versions(company_id,id)
);
CREATE FUNCTION kristine.guard_day_reconciliation_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.imported_day_record_versions d
 JOIN kristine.source_records s ON s.id=d.source_record_id AND s.company_id=d.company_id
 WHERE d.company_id=NEW.company_id AND d.id=NEW.day_record_id AND s.source_instance_id=NEW.source_instance_id)
 THEN RAISE EXCEPTION 'Reconciliation source mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER day_revision_source_guard BEFORE INSERT ON kristine.imported_day_record_versions
 FOR EACH ROW EXECUTE FUNCTION kristine.guard_imported_day_source();
CREATE TRIGGER day_revision_member_guard BEFORE INSERT ON kristine.day_reconciliation_members
 FOR EACH ROW EXECUTE FUNCTION kristine.guard_day_reconciliation_member();
CREATE VIEW kristine.latest_imported_day_records AS
 WITH latest AS (
  SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id
  FROM kristine.day_reconciliation_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id
  WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC
 ) SELECT d.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id
 FROM latest l JOIN kristine.day_reconciliation_members m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.imported_day_record_versions d ON d.company_id=m.company_id AND d.id=m.day_record_id;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imported_day_record_versions','imported_day_record_version_history','day_reconciliation_runs','day_reconciliation_members'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t);
 END LOOP;
END $$;
COMMIT;

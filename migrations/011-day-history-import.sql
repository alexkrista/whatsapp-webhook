BEGIN;
-- Imported records do not activate current day workflows or payroll locks.
CREATE TABLE kristine.imported_day_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
 record_kind text NOT NULL CHECK(record_kind IN ('close','release','correction','review')),
 legacy_id text NOT NULL, employee_id uuid, legacy_employee_id text NOT NULL,
 employee_name_original text, project_id uuid, legacy_project_id text,
 work_date date NOT NULL, source_record_id uuid NOT NULL, source_version_id uuid NOT NULL,
 status_original text, category_original text, source_label text,
 note text, reason text, actor_original text, created_at_original text, updated_at_original text,
 finished_at_original text, released_at_original text, returned_at_original text,
 status_flags jsonb NOT NULL CHECK(jsonb_typeof(status_flags)='object'),
 checks jsonb, original_segments jsonb, content jsonb,
 import_review_reasons text[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,record_kind,legacy_id), UNIQUE(company_id,source_record_id)
);
CREATE TABLE kristine.imported_day_record_history (
 company_id uuid NOT NULL, day_record_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 at_original text, actor_original text, action_original text, reason text, note text,
 before_segments jsonb, after_segments jsonb, raw_payload jsonb NOT NULL,
 PRIMARY KEY(day_record_id,position),
 FOREIGN KEY(company_id,day_record_id) REFERENCES kristine.imported_day_records(company_id,id)
);
CREATE FUNCTION kristine.guard_imported_day_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.id=NEW.source_record_id
 AND s.entity_type='imported_day_'||NEW.record_kind AND s.external_id=NEW.legacy_id) THEN
 RAISE EXCEPTION 'Imported day source mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER imported_day_source_guard BEFORE INSERT ON kristine.imported_day_records FOR EACH ROW EXECUTE FUNCTION kristine.guard_imported_day_source();
CREATE TRIGGER imported_day_immutable BEFORE UPDATE OR DELETE ON kristine.imported_day_records FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER imported_day_no_truncate BEFORE TRUNCATE ON kristine.imported_day_records FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER imported_day_history_immutable BEFORE UPDATE OR DELETE ON kristine.imported_day_record_history FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER imported_day_history_no_truncate BEFORE TRUNCATE ON kristine.imported_day_record_history FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
COMMIT;

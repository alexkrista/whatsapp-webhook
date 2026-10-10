BEGIN;
CREATE TABLE kristine.supplemental_import_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL UNIQUE,
 UNIQUE(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id)
);
CREATE TABLE kristine.imported_visit_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_record_id uuid NOT NULL,source_version_id uuid NOT NULL,legacy_id text NOT NULL,
 legacy_key text,legacy_task_id text,legacy_project_id text,target_original text,status_original text,
 title text,customer_original text,address_original text,contact_phone_original text,contact_email_original text,
 created_at_original text,updated_at_original text,start_date_original text,legacy_start_employee_id text,start_employee_name_original text,
 contract_amount_original text,appointment_date_original text,appointment_from_original text,appointment_to_original text,
 calendar_owner_original text,calendar_account_original text,
 discussion text,work_description text,estimate_description text,next_steps text,protocol_saved_at_original text,
 conversion_target_original text,conversion_status_original text,conversion_prepared_at_original text,protocol_source_task_id text,
 UNIQUE(company_id,id),UNIQUE(company_id,source_record_id,source_version_id),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id)
);
CREATE TABLE kristine.imported_visit_timeline (
 company_id uuid NOT NULL,visit_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),
 type_original text,label_original text,at_original text,raw_payload jsonb NOT NULL,
 PRIMARY KEY(visit_version_id,position),
 FOREIGN KEY(company_id,visit_version_id) REFERENCES kristine.imported_visit_versions(company_id,id)
);
CREATE TABLE kristine.imported_visit_assets (
 company_id uuid NOT NULL,visit_version_id uuid NOT NULL,collection text NOT NULL CHECK(collection IN ('files','recordings')),
 position integer NOT NULL CHECK(position>=0),legacy_id text,legacy_task_id text,name_original text,mime_type_original text,
 size_original text,sha256_original text,url_original text,created_at_original text,recorded_at_original text,consent_at_original text,
 kind_original text,transcript text,transcription_error text,raw_payload jsonb NOT NULL,
 PRIMARY KEY(visit_version_id,collection,position),
 FOREIGN KEY(company_id,visit_version_id) REFERENCES kristine.imported_visit_versions(company_id,id)
);
CREATE TABLE kristine.imported_employee_setting_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_record_id uuid NOT NULL,source_version_id uuid NOT NULL,legacy_employee_id text NOT NULL,
 setting_kind text NOT NULL CHECK(setting_kind IN ('work_rules','contact_email')),
 activity_mode_original text,buak_original boolean,email_original text,
 UNIQUE(company_id,id),UNIQUE(company_id,source_record_id,source_version_id),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id)
);
CREATE TABLE kristine.supplemental_visit_members (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,version_id uuid NOT NULL,
 PRIMARY KEY(import_run_id,version_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.supplemental_import_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,version_id) REFERENCES kristine.imported_visit_versions(company_id,id)
);
CREATE TABLE kristine.supplemental_employee_setting_members (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,version_id uuid NOT NULL,
 PRIMARY KEY(import_run_id,version_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.supplemental_import_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,version_id) REFERENCES kristine.imported_employee_setting_versions(company_id,id)
);
CREATE FUNCTION kristine.guard_supplemental_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; external text;
BEGIN
 IF TG_TABLE_NAME='imported_visit_versions' THEN kind:='visit_workflow';external:=NEW.legacy_id;
 ELSE kind:='employee_'||NEW.setting_kind;external:=NEW.legacy_employee_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.company_id=v.company_id AND s.id=v.source_record_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.id=NEW.source_record_id AND s.entity_type=kind AND s.external_id=external)
 THEN RAISE EXCEPTION 'Supplemental version source mismatch';END IF;RETURN NEW;
END $$;
CREATE FUNCTION kristine.guard_supplemental_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid;
BEGIN
 IF TG_TABLE_NAME='supplemental_visit_members' THEN SELECT source_record_id INTO source_id FROM kristine.imported_visit_versions WHERE company_id=NEW.company_id AND id=NEW.version_id;
 ELSE SELECT source_record_id INTO source_id FROM kristine.imported_employee_setting_versions WHERE company_id=NEW.company_id AND id=NEW.version_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM kristine.source_records s WHERE s.company_id=NEW.company_id AND s.id=source_id AND s.source_instance_id=NEW.source_instance_id)
 THEN RAISE EXCEPTION 'Supplemental membership source mismatch';END IF;RETURN NEW;
END $$;
CREATE TRIGGER supplemental_visit_guard BEFORE INSERT ON kristine.imported_visit_versions FOR EACH ROW EXECUTE FUNCTION kristine.guard_supplemental_version();
CREATE TRIGGER supplemental_setting_guard BEFORE INSERT ON kristine.imported_employee_setting_versions FOR EACH ROW EXECUTE FUNCTION kristine.guard_supplemental_version();
CREATE TRIGGER supplemental_visit_member_guard BEFORE INSERT ON kristine.supplemental_visit_members FOR EACH ROW EXECUTE FUNCTION kristine.guard_supplemental_member();
CREATE TRIGGER supplemental_setting_member_guard BEFORE INSERT ON kristine.supplemental_employee_setting_members FOR EACH ROW EXECUTE FUNCTION kristine.guard_supplemental_member();
CREATE VIEW kristine.latest_supplemental_import_runs AS
 SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id
 FROM kristine.supplemental_import_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id
 WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC;
CREATE VIEW kristine.latest_imported_visits AS
 SELECT v.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id,x.project_id AS resolved_project_id
 FROM kristine.latest_supplemental_import_runs l JOIN kristine.supplemental_visit_members m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.imported_visit_versions v ON v.company_id=m.company_id AND v.id=m.version_id
 LEFT JOIN kristine.source_records s ON s.company_id=l.company_id AND s.source_instance_id=l.source_instance_id AND s.entity_type='project' AND s.external_id=v.legacy_project_id
 LEFT JOIN kristine.external_references x ON x.company_id=s.company_id AND x.source_record_id=s.id;
CREATE VIEW kristine.latest_imported_employee_settings AS
 SELECT v.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id,x.employee_id AS resolved_employee_id
 FROM kristine.latest_supplemental_import_runs l JOIN kristine.supplemental_employee_setting_members m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.imported_employee_setting_versions v ON v.company_id=m.company_id AND v.id=m.version_id
 LEFT JOIN kristine.source_records s ON s.company_id=l.company_id AND s.source_instance_id=l.source_instance_id AND s.entity_type='employee' AND s.external_id=v.legacy_employee_id
 LEFT JOIN kristine.external_references x ON x.company_id=s.company_id AND x.source_record_id=s.id;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['supplemental_import_runs','imported_visit_versions','imported_visit_timeline','imported_visit_assets','imported_employee_setting_versions','supplemental_visit_members','supplemental_employee_setting_members'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t);
 EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t);
 END LOOP;END $$;
COMMIT;

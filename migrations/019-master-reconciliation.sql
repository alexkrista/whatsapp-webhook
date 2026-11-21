BEGIN;
CREATE TABLE kristine.master_reconciliation_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id),
 UNIQUE(company_id,source_instance_id,import_run_id)
);
CREATE TABLE kristine.imported_contact_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_record_id uuid NOT NULL,source_version_id uuid NOT NULL,legacy_id text NOT NULL,
 contact_group_id uuid,display_name text NOT NULL,phone text,email text,
 import_review_reasons text[] NOT NULL DEFAULT '{}',projection_sha256 text NOT NULL CHECK(projection_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(company_id,id),UNIQUE(company_id,source_record_id,source_version_id,projection_sha256),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 FOREIGN KEY(company_id,contact_group_id) REFERENCES kristine.contact_groups(company_id,id)
);
CREATE TABLE kristine.imported_contact_member_versions (
 company_id uuid NOT NULL,contact_version_id uuid NOT NULL,member_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('person','organization')),display_name text NOT NULL,email text,phone text,
 PRIMARY KEY(contact_version_id,member_key),
 FOREIGN KEY(company_id,contact_version_id) REFERENCES kristine.imported_contact_versions(company_id,id)
);
CREATE TABLE kristine.imported_project_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_record_id uuid NOT NULL,source_version_id uuid NOT NULL,legacy_id text NOT NULL,
 project_id uuid,name text NOT NULL,status smallint CHECK(status BETWEEN 1 AND 5),offer_outcome text,
 street text,house_number text,postal_code text,city text,address_extra text,country_original text,
 import_review_reasons text[] NOT NULL DEFAULT '{}',projection_sha256 text NOT NULL CHECK(projection_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(company_id,id),UNIQUE(company_id,source_record_id,source_version_id,projection_sha256),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id)
);
CREATE TABLE kristine.master_reconciliation_contacts (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,contact_version_id uuid NOT NULL,
 PRIMARY KEY(import_run_id,contact_version_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.master_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,contact_version_id) REFERENCES kristine.imported_contact_versions(company_id,id)
);
CREATE TABLE kristine.master_reconciliation_projects (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,project_version_id uuid NOT NULL,
 PRIMARY KEY(import_run_id,project_version_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.master_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,project_version_id) REFERENCES kristine.imported_project_versions(company_id,id)
);
CREATE TABLE kristine.master_reconciliation_project_contacts (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,project_version_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','siteManager','architect')),legacy_contact_id text,
 contact_version_id uuid,raw_reference jsonb NOT NULL,import_review_reasons text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(import_run_id,project_version_id,role),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.master_reconciliation_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(import_run_id,project_version_id) REFERENCES kristine.master_reconciliation_projects(import_run_id,project_version_id),
 FOREIGN KEY(import_run_id,contact_version_id) REFERENCES kristine.master_reconciliation_contacts(import_run_id,contact_version_id),
 FOREIGN KEY(company_id,project_version_id) REFERENCES kristine.imported_project_versions(company_id,id),
 FOREIGN KEY(company_id,contact_version_id) REFERENCES kristine.imported_contact_versions(company_id,id)
);
CREATE FUNCTION kristine.guard_master_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_type text;
BEGIN
 expected_type:=CASE WHEN TG_TABLE_NAME='imported_contact_versions' THEN 'contact_group' ELSE 'project' END;
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.id=NEW.source_record_id AND s.entity_type=expected_type AND s.external_id=NEW.legacy_id)
 THEN RAISE EXCEPTION 'Master version source mismatch'; END IF; RETURN NEW;
END $$;
CREATE FUNCTION kristine.guard_master_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='master_reconciliation_contacts' THEN
  IF NOT EXISTS(SELECT 1 FROM kristine.imported_contact_versions d JOIN kristine.source_records s ON s.id=d.source_record_id AND s.company_id=d.company_id
  WHERE d.company_id=NEW.company_id AND d.id=NEW.contact_version_id AND s.source_instance_id=NEW.source_instance_id)
  THEN RAISE EXCEPTION 'Contact membership source mismatch'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM kristine.imported_project_versions d JOIN kristine.source_records s ON s.id=d.source_record_id AND s.company_id=d.company_id
  WHERE d.company_id=NEW.company_id AND d.id=NEW.project_version_id AND s.source_instance_id=NEW.source_instance_id)
  THEN RAISE EXCEPTION 'Project membership source mismatch'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER contact_version_guard BEFORE INSERT ON kristine.imported_contact_versions FOR EACH ROW EXECUTE FUNCTION kristine.guard_master_version();
CREATE TRIGGER project_version_guard BEFORE INSERT ON kristine.imported_project_versions FOR EACH ROW EXECUTE FUNCTION kristine.guard_master_version();
CREATE TRIGGER contact_membership_guard BEFORE INSERT ON kristine.master_reconciliation_contacts FOR EACH ROW EXECUTE FUNCTION kristine.guard_master_membership();
CREATE TRIGGER project_membership_guard BEFORE INSERT ON kristine.master_reconciliation_projects FOR EACH ROW EXECUTE FUNCTION kristine.guard_master_membership();
CREATE VIEW kristine.latest_master_reconciliation_runs AS
 SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id
 FROM kristine.master_reconciliation_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id
 WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC;
CREATE VIEW kristine.latest_imported_contacts AS
 SELECT d.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id
 FROM kristine.latest_master_reconciliation_runs l JOIN kristine.master_reconciliation_contacts m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.imported_contact_versions d ON d.company_id=m.company_id AND d.id=m.contact_version_id;
CREATE VIEW kristine.latest_imported_projects AS
 SELECT d.*,l.source_instance_id,l.import_run_id AS reconciliation_run_id
 FROM kristine.latest_master_reconciliation_runs l JOIN kristine.master_reconciliation_projects m
 ON m.company_id=l.company_id AND m.source_instance_id=l.source_instance_id AND m.import_run_id=l.import_run_id
 JOIN kristine.imported_project_versions d ON d.company_id=m.company_id AND d.id=m.project_version_id;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['master_reconciliation_runs','imported_contact_versions','imported_contact_member_versions','imported_project_versions','master_reconciliation_project_contacts','master_reconciliation_contacts','master_reconciliation_projects'] LOOP
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t);
 END LOOP;
END $$;
COMMIT;

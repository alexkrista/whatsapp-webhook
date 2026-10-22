BEGIN;
CREATE TABLE kristine.external_dataset_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL UNIQUE,
 UNIQUE(company_id,source_instance_id,import_run_id),FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id));
CREATE TABLE kristine.external_dataset_files (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,source_version_id uuid NOT NULL,source_path text NOT NULL,
 dataset_kind text NOT NULL CHECK(dataset_kind IN ('archive_index','sql_table')),source_metadata jsonb NOT NULL,
 PRIMARY KEY(import_run_id,source_path),FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.external_dataset_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE TABLE kristine.imported_external_dataset_rows (
 company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),raw_payload jsonb NOT NULL CHECK(jsonb_typeof(raw_payload)='object'),
 PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE FUNCTION kristine.guard_external_dataset_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;src uuid;BEGIN
 SELECT s.external_id,s.source_instance_id INTO p,src FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.company_id=v.company_id AND s.id=v.source_record_id WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='json_file_snapshot';
 IF p IS NULL OR NOT (p='archive/pdf-index-metadata.json' OR p LIKE 'sql/WinWorker_%/dbo/%.json') THEN RAISE EXCEPTION 'External dataset source mismatch';END IF;
 IF TG_TABLE_NAME='external_dataset_files' THEN
  IF src<>NEW.source_instance_id OR p<>NEW.source_path OR (p='archive/pdf-index-metadata.json')<>(NEW.dataset_kind='archive_index') THEN RAISE EXCEPTION 'External dataset membership mismatch';END IF;
 END IF;RETURN NEW;END $$;
CREATE VIEW kristine.latest_external_dataset_runs AS SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id FROM kristine.external_dataset_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC;
CREATE VIEW kristine.latest_external_dataset_files AS SELECT f.* FROM kristine.latest_external_dataset_runs l JOIN kristine.external_dataset_files f USING(company_id,source_instance_id,import_run_id);
CREATE VIEW kristine.latest_external_dataset_rows AS SELECT e.*,f.source_instance_id,f.source_path,f.dataset_kind,f.source_metadata,f.import_run_id AS reconciliation_run_id FROM kristine.latest_external_dataset_files f JOIN kristine.imported_external_dataset_rows e USING(company_id,source_version_id);
CREATE VIEW kristine.latest_external_archive_index AS SELECT r.*,
 raw_payload->>'path' AS original_path,raw_payload->>'filename' AS filename_original,raw_payload->>'dokumenttyp' AS document_type_original,raw_payload->>'source' AS source_label_original,
 raw_payload->>'logical_id' AS logical_id_original,raw_payload->>'fingerprint' AS fingerprint_original,raw_payload->>'doc_year' AS document_year_original,raw_payload->>'doc_month' AS document_month_original,
 raw_payload->>'size' AS indexed_size_original,raw_payload->>'file_size' AS file_size_original,raw_payload->>'text_length' AS indexed_text_length_original,
 raw_payload->>'modified' AS modified_original,raw_payload->>'indexed_at' AS indexed_at_original
 FROM kristine.latest_external_dataset_rows r WHERE dataset_kind='archive_index';
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['external_dataset_runs','external_dataset_files','imported_external_dataset_rows'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t);
 EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t);
 IF t<>'external_dataset_runs' THEN EXECUTE format('CREATE TRIGGER source_guard BEFORE INSERT ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.guard_external_dataset_source()',t);END IF;
 END LOOP;END $$;
COMMIT;

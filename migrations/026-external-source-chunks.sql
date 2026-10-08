BEGIN;
CREATE TABLE kristine.external_source_chunks (
 company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),
 original_bytes integer NOT NULL CHECK(original_bytes BETWEEN 1 AND 2097152),original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),gzip_bytes bytea NOT NULL CHECK(octet_length(gzip_bytes)<=2200000),
 PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE FUNCTION kristine.guard_large_source_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id JOIN kristine.source_instances i ON i.id=v.source_instance_id WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='large_json_file_snapshot' AND s.external_id='sql/WinWorker_Mitschreibung_Standard/dbo/Stundenmitschreibung.json' AND i.system_code='winworker' AND i.instance_key='srv-db01-winworker-standard-time-history' AND v.raw_payload->>'storage'='gzip_chunks_v1') THEN RAISE EXCEPTION 'Large source chunk mismatch';END IF;RETURN NEW;END $$;
CREATE TRIGGER source_guard BEFORE INSERT ON kristine.external_source_chunks FOR EACH ROW EXECUTE FUNCTION kristine.guard_large_source_chunk();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.external_source_chunks FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.external_source_chunks FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE OR REPLACE FUNCTION kristine.guard_external_dataset_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;src uuid;kind text;BEGIN
 SELECT s.external_id,s.source_instance_id,s.entity_type INTO p,src,kind FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.company_id=v.company_id AND s.id=v.source_record_id WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type IN ('json_file_snapshot','large_json_file_snapshot');
 IF p IS NULL OR NOT (p='archive/pdf-index-metadata.json' OR p LIKE 'sql/WinWorker_%/dbo/%.json') THEN RAISE EXCEPTION 'External dataset source mismatch';END IF;
 IF kind='large_json_file_snapshot' AND NOT EXISTS(SELECT 1 FROM kristine.source_instances i WHERE i.company_id=NEW.company_id AND i.id=src AND i.system_code='winworker' AND i.instance_key='srv-db01-winworker-standard-time-history' AND p='sql/WinWorker_Mitschreibung_Standard/dbo/Stundenmitschreibung.json') THEN RAISE EXCEPTION 'Large external dataset source mismatch';END IF;
 IF TG_TABLE_NAME='external_dataset_files' THEN
  IF src<>NEW.source_instance_id OR p<>NEW.source_path OR (p='archive/pdf-index-metadata.json')<>(NEW.dataset_kind='archive_index') THEN RAISE EXCEPTION 'External dataset membership mismatch';END IF;
 END IF;RETURN NEW;END $$;
COMMIT;

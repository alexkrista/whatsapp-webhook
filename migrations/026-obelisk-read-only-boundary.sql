-- KRISTINE 2.0: OBELISK supplies personnel history through a read-only connection.
-- It is NOT a source of imported KRISTINE/SQL time or personnel data.
-- Applied explicitly in the isolated SQL-test environment before any cutover.
BEGIN;

CREATE FUNCTION kristine.reject_obelisk_import() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, kristine AS $$
DECLARE
  system_name text;
BEGIN
  SELECT si.system_code INTO system_name
    FROM kristine.source_instances si
   WHERE si.company_id = NEW.company_id AND si.id = NEW.source_instance_id;
  IF system_name = 'obelisk' THEN
    RAISE EXCEPTION 'OBELISK historical data is read-only and must not be imported into KRISTINE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_obelisk_import_runs
  BEFORE INSERT OR UPDATE OF company_id, source_instance_id ON kristine.import_runs
  FOR EACH ROW EXECUTE FUNCTION kristine.reject_obelisk_import();

CREATE TRIGGER guard_obelisk_source_records
  BEFORE INSERT OR UPDATE OF company_id, source_instance_id ON kristine.source_records
  FOR EACH ROW EXECUTE FUNCTION kristine.reject_obelisk_import();

CREATE TRIGGER guard_obelisk_source_versions
  BEFORE INSERT OR UPDATE OF company_id, source_instance_id ON kristine.source_record_versions
  FOR EACH ROW EXECUTE FUNCTION kristine.reject_obelisk_import();

CREATE FUNCTION kristine.guard_obelisk_instance_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, kristine AS $$
BEGIN
  IF OLD.system_code IS DISTINCT FROM NEW.system_code
    AND (OLD.system_code = 'obelisk' OR NEW.system_code = 'obelisk') THEN
    RAISE EXCEPTION 'OBELISK source identity cannot be changed to bypass the read-only boundary'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_obelisk_source_identity
  BEFORE UPDATE OF system_code ON kristine.source_instances
  FOR EACH ROW EXECUTE FUNCTION kristine.guard_obelisk_instance_identity();

COMMENT ON FUNCTION kristine.reject_obelisk_import() IS
  'OBELISK is a read-only external historical personnel-time source through 2026-09-30. All imported records are prohibited; KRISZEIT is authoritative from 2026-10-01.';

COMMIT;

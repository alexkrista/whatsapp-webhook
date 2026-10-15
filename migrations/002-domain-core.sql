-- Isolated test database first. No application-startup execution.
BEGIN;
CREATE SCHEMA kristine;

CREATE TABLE kristine.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE kristine.source_systems (
  code text PRIMARY KEY CHECK (btrim(code) <> ''), name text NOT NULL
);
INSERT INTO kristine.source_systems VALUES ('kristine','Kristine'),('winworker','WinWorker'),('obelisk','Obelisk');
CREATE TABLE kristine.source_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  system_code text NOT NULL REFERENCES kristine.source_systems(code),
  instance_key text NOT NULL CHECK (btrim(instance_key) <> ''),
  UNIQUE (company_id, system_code, instance_key), UNIQUE (company_id,id)
);
CREATE TABLE kristine.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, source_instance_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','validated','failed')),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (company_id,source_instance_id) REFERENCES kristine.source_instances(company_id,id),
  UNIQUE (company_id,source_instance_id,id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE TABLE kristine.source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, source_instance_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  external_id text NOT NULL CHECK (btrim(external_id) <> ''),
  FOREIGN KEY (company_id,source_instance_id) REFERENCES kristine.source_instances(company_id,id),
  UNIQUE (company_id,source_instance_id,entity_type,external_id),
  UNIQUE (company_id,id), UNIQUE (company_id,source_instance_id,id)
);
CREATE TABLE kristine.source_record_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, source_instance_id uuid NOT NULL,
  source_record_id uuid NOT NULL, import_run_id uuid NOT NULL,
  raw_payload jsonb NOT NULL, original_text text,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (company_id,source_instance_id,source_record_id) REFERENCES kristine.source_records(company_id,source_instance_id,id),
  FOREIGN KEY (company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id),
  UNIQUE (source_record_id,import_run_id), UNIQUE (company_id,id)
);
CREATE TABLE kristine.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  kind text NOT NULL CHECK (kind IN ('person','organization')),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  email text, phone text, vat_number text,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.party_roles (
  company_id uuid NOT NULL, party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('customer','supplier','employee','other')),
  PRIMARY KEY (party_id,role),
  FOREIGN KEY (company_id,party_id) REFERENCES kristine.parties(company_id,id)
);
CREATE TABLE kristine.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  street text, postal_code text, city text, country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
  latitude numeric(10,7) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) CHECK (longitude BETWEEN -180 AND 180),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.party_addresses (
  company_id uuid NOT NULL, party_id uuid NOT NULL, address_id uuid NOT NULL,
  role text NOT NULL, PRIMARY KEY (party_id,address_id,role),
  FOREIGN KEY (company_id,party_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY (company_id,address_id) REFERENCES kristine.addresses(company_id,id)
);
CREATE TABLE kristine.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  party_id uuid, display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (company_id,party_id) REFERENCES kristine.parties(company_id,id),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.employee_external_ids (
  company_id uuid NOT NULL, employee_id uuid NOT NULL,
  namespace text NOT NULL CHECK (btrim(namespace) <> ''),
  external_id text NOT NULL CHECK (btrim(external_id) <> ''),
  PRIMARY KEY (company_id,namespace,external_id),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id)
);
CREATE TABLE kristine.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  project_number text NOT NULL CHECK (btrim(project_number) <> ''),
  name text NOT NULL, status smallint NOT NULL CHECK (status BETWEEN 1 AND 5),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (company_id,project_number), UNIQUE (company_id,id)
);
CREATE TABLE kristine.project_parties (
  company_id uuid NOT NULL, project_id uuid NOT NULL, party_id uuid NOT NULL,
  role text NOT NULL, PRIMARY KEY (project_id,party_id,role),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY (company_id,party_id) REFERENCES kristine.parties(company_id,id)
);
CREATE TABLE kristine.project_addresses (
  company_id uuid NOT NULL, project_id uuid NOT NULL, address_id uuid NOT NULL,
  role text NOT NULL, PRIMARY KEY (project_id,address_id,role),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY (company_id,address_id) REFERENCES kristine.addresses(company_id,id)
);
CREATE TABLE kristine.collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  collection_number text NOT NULL, name text NOT NULL,
  UNIQUE (company_id,collection_number), UNIQUE (company_id,id)
);
CREATE TABLE kristine.collection_members (
  company_id uuid NOT NULL, collection_id uuid NOT NULL, project_id uuid NOT NULL,
  PRIMARY KEY (collection_id,project_id),
  FOREIGN KEY (company_id,collection_id) REFERENCES kristine.collections(company_id,id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id)
);
CREATE TABLE kristine.worktime_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  name text NOT NULL, rule_version text NOT NULL,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.employee_worktime_models (
  company_id uuid NOT NULL, employee_id uuid NOT NULL, model_id uuid NOT NULL,
  valid_from date NOT NULL, valid_until date,
  PRIMARY KEY (employee_id,valid_from),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  FOREIGN KEY (company_id,model_id) REFERENCES kristine.worktime_models(company_id,id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE TABLE kristine.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, project_id uuid,
  work_date date NOT NULL, starts_at time, ends_at time, activity_code text NOT NULL,
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL,
  starts_on date NOT NULL, ends_on date NOT NULL, reason_code text NOT NULL,
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK (ends_on >= starts_on), UNIQUE (company_id,id)
);
CREATE TABLE kristine.time_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, project_id uuid,
  work_date date NOT NULL, event_type text NOT NULL,
  actual_at timestamptz, booked_time time,
  origin text NOT NULL CHECK (origin IN ('manual','automatic','whatsapp','kgo')),
  rule_version text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.time_month_locks (
  company_id uuid NOT NULL, employee_id uuid NOT NULL, month_start date NOT NULL,
  PRIMARY KEY (company_id,employee_id,month_start),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK (extract(day FROM month_start) = 1)
);
CREATE TABLE kristine.time_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, project_id uuid,
  work_date date NOT NULL, starts_at timestamptz, ends_at timestamptz,
  activity_code text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('manual','automatic','derived','legacy')),
  payroll_minutes numeric(12,4) NOT NULL CHECK (payroll_minutes >= 0),
  productive_minutes numeric(12,4) NOT NULL CHECK (productive_minutes >= 0),
  break_minutes numeric(12,4) NOT NULL CHECK (break_minutes >= 0),
  rule_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at >= starts_at)),
  UNIQUE (company_id,id), UNIQUE (company_id,employee_id,id)
);
CREATE INDEX time_segments_employee_date ON kristine.time_segments(company_id,employee_id,work_date);
CREATE INDEX time_segments_project_date ON kristine.time_segments(company_id,project_id,work_date);
CREATE INDEX time_events_employee_date ON kristine.time_events(company_id,employee_id,work_date);
CREATE INDEX assignments_employee_date ON kristine.assignments(company_id,employee_id,work_date);
CREATE TABLE kristine.time_segment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, segment_id uuid NOT NULL,
  revision bigint NOT NULL, operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(), captured_by text NOT NULL DEFAULT session_user,
  record jsonb NOT NULL,
  UNIQUE (segment_id,revision,operation)
);
CREATE TABLE kristine.day_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, work_date date NOT NULL,
  complete boolean NOT NULL, checks jsonb NOT NULL, note text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  UNIQUE (company_id,employee_id,work_date)
);
CREATE TABLE kristine.payroll_month_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, month_start date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','closed')),
  employee_name_snapshot text NOT NULL, personnel_number_snapshot text,
  rule_version text NOT NULL,
  calculation_rules_snapshot jsonb NOT NULL CHECK (jsonb_typeof(calculation_rules_snapshot) = 'object'),
  payroll_minutes numeric(14,4) NOT NULL CHECK (payroll_minutes >= 0),
  productive_minutes numeric(14,4) NOT NULL CHECK (productive_minutes >= 0),
  break_minutes numeric(14,4) NOT NULL CHECK (break_minutes >= 0),
  closed_at timestamptz, closed_by text,
  FOREIGN KEY (company_id,employee_id,month_start) REFERENCES kristine.time_month_locks(company_id,employee_id,month_start),
  CHECK (extract(day FROM month_start) = 1),
  CHECK ((status = 'draft' AND closed_at IS NULL AND closed_by IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  UNIQUE (company_id,employee_id,month_start), UNIQUE (company_id,employee_id,id), UNIQUE (company_id,id)
);
CREATE TABLE kristine.payroll_snapshot_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, employee_id uuid NOT NULL, close_id uuid NOT NULL,
  source_segment_id uuid NOT NULL, source_revision bigint NOT NULL,
  work_date date NOT NULL, activity_code text NOT NULL,
  project_number_snapshot text, project_name_snapshot text,
  starts_at timestamptz, ends_at timestamptz,
  payroll_minutes numeric(12,4) NOT NULL CHECK (payroll_minutes >= 0),
  productive_minutes numeric(12,4) NOT NULL CHECK (productive_minutes >= 0),
  break_minutes numeric(12,4) NOT NULL CHECK (break_minutes >= 0),
  rule_version text NOT NULL,
  FOREIGN KEY (company_id,employee_id,close_id) REFERENCES kristine.payroll_month_closes(company_id,employee_id,id),
  UNIQUE (close_id,source_segment_id)
  -- No mutable-source FK: source deletion must not erase or block the immutable historical snapshot.
);
CREATE TABLE kristine.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  document_type text NOT NULL, title text NOT NULL,
  UNIQUE (company_id,id)
);
CREATE TABLE kristine.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, document_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  storage_key text NOT NULL, media_type text NOT NULL,
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (company_id,document_id) REFERENCES kristine.documents(company_id,id),
  UNIQUE (document_id,version)
);
CREATE TABLE kristine.project_documents (
  company_id uuid NOT NULL, project_id uuid NOT NULL, document_id uuid NOT NULL,
  PRIMARY KEY (project_id,document_id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY (company_id,document_id) REFERENCES kristine.documents(company_id,id)
);
CREATE TABLE kristine.external_references (
  company_id uuid NOT NULL, source_record_id uuid PRIMARY KEY,
  party_id uuid, employee_id uuid, project_id uuid, segment_id uuid, document_id uuid,
  FOREIGN KEY (company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
  FOREIGN KEY (company_id,party_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY (company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  FOREIGN KEY (company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY (company_id,segment_id) REFERENCES kristine.time_segments(company_id,id),
  FOREIGN KEY (company_id,document_id) REFERENCES kristine.documents(company_id,id),
  CHECK (num_nonnulls(party_id,employee_id,project_id,segment_id,document_id) = 1)
);

CREATE FUNCTION kristine.lock_time_month(p_company uuid,p_employee uuid,p_date date) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
DECLARE m date := date_trunc('month',p_date)::date;
BEGIN
  INSERT INTO kristine.time_month_locks VALUES (p_company,p_employee,m) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM kristine.time_month_locks WHERE company_id=p_company AND employee_id=p_employee AND month_start=m FOR UPDATE;
END $$;
CREATE FUNCTION kristine.guard_time_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
BEGIN
  PERFORM kristine.lock_time_month(NEW.company_id,NEW.employee_id,NEW.work_date);
  RETURN NEW;
END $$;
CREATE TRIGGER time_event_month_guard BEFORE INSERT ON kristine.time_events FOR EACH ROW EXECUTE FUNCTION kristine.guard_time_event_insert();
CREATE FUNCTION kristine.guard_time_segment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM kristine.lock_time_month(OLD.company_id,OLD.employee_id,OLD.work_date); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM kristine.lock_time_month(NEW.company_id,NEW.employee_id,NEW.work_date); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id OR NEW.work_date <> OLD.work_date THEN
      RAISE EXCEPTION 'Segment identity/date is immutable; delete and recreate in one transaction';
    END IF;
    NEW.revision := OLD.revision + 1;
  ELSIF TG_OP = 'INSERT' THEN NEW.revision := 1;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_segment_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.time_segments FOR EACH ROW EXECUTE FUNCTION kristine.guard_time_segment();
CREATE FUNCTION kristine.audit_time_segment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO kristine.time_segment_revisions(company_id,segment_id,revision,operation,record) VALUES (OLD.company_id,OLD.id,OLD.revision,TG_OP,to_jsonb(OLD));
    RETURN OLD;
  END IF;
  INSERT INTO kristine.time_segment_revisions(company_id,segment_id,revision,operation,record) VALUES (NEW.company_id,NEW.id,NEW.revision,TG_OP,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER time_segment_audit AFTER INSERT OR UPDATE OR DELETE ON kristine.time_segments FOR EACH ROW EXECUTE FUNCTION kristine.audit_time_segment();

CREATE FUNCTION kristine.guard_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
DECLARE c kristine.payroll_month_closes%ROWTYPE; s kristine.time_segments%ROWTYPE; p kristine.projects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO STRICT c FROM kristine.payroll_month_closes WHERE id=OLD.close_id;
    PERFORM kristine.lock_time_month(c.company_id,c.employee_id,c.month_start);
    SELECT * INTO STRICT c FROM kristine.payroll_month_closes WHERE id=OLD.close_id;
    IF c.status='closed' THEN RAISE EXCEPTION 'Closed payroll snapshot is immutable'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO STRICT c FROM kristine.payroll_month_closes WHERE id=NEW.close_id;
    PERFORM kristine.lock_time_month(c.company_id,c.employee_id,c.month_start);
    SELECT * INTO STRICT c FROM kristine.payroll_month_closes WHERE id=NEW.close_id;
    IF c.status='closed' THEN RAISE EXCEPTION 'Closed payroll snapshot is immutable'; END IF;
    IF NEW.company_id<>c.company_id OR NEW.employee_id<>c.employee_id OR date_trunc('month',NEW.work_date)::date<>c.month_start THEN RAISE EXCEPTION 'Snapshot ownership/month mismatch'; END IF;
    SELECT * INTO STRICT s FROM kristine.time_segments WHERE id=NEW.source_segment_id;
    IF s.company_id<>NEW.company_id OR s.employee_id<>NEW.employee_id OR s.work_date<>NEW.work_date OR s.origin='legacy' THEN RAISE EXCEPTION 'Invalid live snapshot source'; END IF;
    IF ROW(s.revision,s.activity_code,s.starts_at,s.ends_at,s.payroll_minutes,s.productive_minutes,s.break_minutes,s.rule_version) IS DISTINCT FROM ROW(NEW.source_revision,NEW.activity_code,NEW.starts_at,NEW.ends_at,NEW.payroll_minutes,NEW.productive_minutes,NEW.break_minutes,NEW.rule_version) THEN RAISE EXCEPTION 'Snapshot values differ from source'; END IF;
    IF s.project_id IS NULL THEN
      IF NEW.project_number_snapshot IS NOT NULL OR NEW.project_name_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Snapshot project differs from source'; END IF;
    ELSE
      SELECT * INTO STRICT p FROM kristine.projects WHERE id=s.project_id;
      IF ROW(NEW.project_number_snapshot,NEW.project_name_snapshot) IS DISTINCT FROM ROW(p.project_number,p.name) THEN RAISE EXCEPTION 'Snapshot project differs from source'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.payroll_snapshot_segments FOR EACH ROW EXECUTE FUNCTION kristine.guard_snapshot();

CREATE FUNCTION kristine.guard_month_close() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,kristine AS $$
DECLARE paid numeric; productive numeric; breaks numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM kristine.lock_time_month(OLD.company_id,OLD.employee_id,OLD.month_start);
    IF OLD.status='closed' THEN RAISE EXCEPTION 'Closed payroll month is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  PERFORM kristine.lock_time_month(NEW.company_id,NEW.employee_id,NEW.month_start);
  IF TG_OP='INSERT' AND NEW.status<>'draft' THEN RAISE EXCEPTION 'Month must be inserted as draft'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.company_id,NEW.employee_id,NEW.month_start) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.employee_id,OLD.month_start) THEN RAISE EXCEPTION 'Month identity is immutable'; END IF;
  IF NEW.status='closed' THEN
    IF EXISTS (
      SELECT 1 FROM kristine.time_segments s
      FULL JOIN (SELECT * FROM kristine.payroll_snapshot_segments WHERE close_id=NEW.id) p ON p.source_segment_id=s.id
      WHERE ((s.company_id=NEW.company_id AND s.employee_id=NEW.employee_id AND date_trunc('month',s.work_date)::date=NEW.month_start AND s.origin<>'legacy') OR p.id IS NOT NULL)
      AND (s.id IS NULL OR p.id IS NULL OR s.origin='legacy' OR ROW(s.revision,s.activity_code,s.starts_at,s.ends_at,s.payroll_minutes,s.productive_minutes,s.break_minutes,s.rule_version) IS DISTINCT FROM ROW(p.source_revision,p.activity_code,p.starts_at,p.ends_at,p.payroll_minutes,p.productive_minutes,p.break_minutes,p.rule_version))
    ) THEN RAISE EXCEPTION 'Month snapshot is incomplete or stale'; END IF;
    SELECT coalesce(sum(payroll_minutes),0),coalesce(sum(productive_minutes),0),coalesce(sum(break_minutes),0) INTO paid,productive,breaks FROM kristine.payroll_snapshot_segments WHERE close_id=NEW.id;
    IF ROW(NEW.payroll_minutes,NEW.productive_minutes,NEW.break_minutes) IS DISTINCT FROM ROW(paid,productive,breaks) THEN RAISE EXCEPTION 'Month totals differ from snapshot'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_month_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.payroll_month_closes FOR EACH ROW EXECUTE FUNCTION kristine.guard_month_close();

CREATE FUNCTION kristine.reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Historical records are append-only'; END $$;
CREATE TRIGGER time_event_immutable BEFORE UPDATE OR DELETE ON kristine.time_events FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER time_revision_immutable BEFORE UPDATE OR DELETE ON kristine.time_segment_revisions FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER source_version_immutable BEFORE UPDATE OR DELETE ON kristine.source_record_versions FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER payroll_snapshot_no_truncate BEFORE TRUNCATE ON kristine.payroll_snapshot_segments FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER payroll_close_no_truncate BEFORE TRUNCATE ON kristine.payroll_month_closes FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER time_event_no_truncate BEFORE TRUNCATE ON kristine.time_events FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER time_revision_no_truncate BEFORE TRUNCATE ON kristine.time_segment_revisions FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER source_version_no_truncate BEFORE TRUNCATE ON kristine.source_record_versions FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
COMMIT;

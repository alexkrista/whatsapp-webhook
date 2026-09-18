BEGIN;

CREATE SCHEMA IF NOT EXISTS kristine;

CREATE TABLE IF NOT EXISTS kristine.schema_migrations (
  version text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kristine.source_imports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system text NOT NULL,
  source_name text NOT NULL,
  source_sha256 text,
  source_modified_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  import_mode text NOT NULL DEFAULT 'shadow'
    CHECK (import_mode IN ('shadow', 'dual_write', 'authoritative')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (source_system, source_name, source_sha256)
);

CREATE TABLE IF NOT EXISTS kristine.jobs (
  job_no text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'Angebot'
    CHECK (status IN (
      'Angebot', 'Auftrag', 'Laufend', 'Fertig – nicht abgerechnet',
      'Abgerechnet', 'Geschlossen'
    )),
  street text NOT NULL DEFAULT '',
  house_number text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  ww_project_number text,
  ww_project_index integer CHECK (ww_project_index IS NULL OR ww_project_index >= 0),
  ww_address_id text,
  ww_customer_number text,
  source_system text NOT NULL DEFAULT 'KRISTINE',
  source_import_id bigint REFERENCES kristine.source_imports(id),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_ww_project_unique
  ON kristine.jobs (ww_project_number)
  WHERE ww_project_number IS NOT NULL AND ww_project_number <> '';

CREATE TABLE IF NOT EXISTS kristine.job_collections (
  collection_no text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'Auftrag'
    CHECK (status IN (
      'Angebot', 'Auftrag', 'Laufend', 'Fertig – nicht abgerechnet',
      'Abgerechnet', 'Geschlossen'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kristine.job_collection_members (
  collection_no text NOT NULL REFERENCES kristine.job_collections(collection_no) ON DELETE RESTRICT,
  job_no text NOT NULL REFERENCES kristine.jobs(job_no) ON DELETE RESTRICT,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_no, job_no),
  UNIQUE (job_no)
);

CREATE TABLE IF NOT EXISTS kristine.employees (
  employee_key text PRIMARY KEY,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  employment_start date,
  employment_end date,
  source_system text NOT NULL DEFAULT 'KRISTINE',
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (employment_end IS NULL OR employment_start IS NULL OR employment_end >= employment_start)
);

CREATE TABLE IF NOT EXISTS kristine.job_budgets (
  job_no text PRIMARY KEY REFERENCES kristine.jobs(job_no) ON DELETE RESTRICT,
  contract_amount_cents bigint NOT NULL DEFAULT 0 CHECK (contract_amount_cents >= 0),
  external_services_cents bigint NOT NULL DEFAULT 0 CHECK (external_services_cents >= 0),
  material_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (material_percent BETWEEN 0 AND 100),
  billing_rate_cents integer NOT NULL DEFAULT 0 CHECK (billing_rate_cents >= 0),
  fixed_target_minutes integer NOT NULL DEFAULT 0 CHECK (fixed_target_minutes >= 0),
  planned_regie_minutes integer NOT NULL DEFAULT 0 CHECK (planned_regie_minutes >= 0),
  calculation_version text NOT NULL DEFAULT 'legacy-import-v1',
  source_import_id bigint REFERENCES kristine.source_imports(id),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kristine.work_segments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system text NOT NULL,
  source_key text NOT NULL,
  source_import_id bigint REFERENCES kristine.source_imports(id),
  job_no text NOT NULL REFERENCES kristine.jobs(job_no) ON DELETE RESTRICT,
  employee_key text REFERENCES kristine.employees(employee_key) ON DELETE RESTRICT,
  work_date date NOT NULL,
  started_at time,
  ended_at time,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 24 * 60),
  billing_type text NOT NULL CHECK (billing_type IN ('order', 'regie')),
  activity_type text NOT NULL DEFAULT 'work'
    CHECK (activity_type IN ('work', 'travel', 'preparation', 'other')),
  supersedes_id bigint REFERENCES kristine.work_segments(id) ON DELETE RESTRICT,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_key),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at > started_at)
);

CREATE INDEX IF NOT EXISTS work_segments_job_date_idx
  ON kristine.work_segments (job_no, work_date);
CREATE INDEX IF NOT EXISTS work_segments_employee_date_idx
  ON kristine.work_segments (employee_key, work_date);

CREATE TABLE IF NOT EXISTS kristine.offers (
  offer_no text PRIMARY KEY,
  job_no text NOT NULL REFERENCES kristine.jobs(job_no) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent', 'accepted', 'rejected', 'expired')),
  net_amount_cents bigint NOT NULL DEFAULT 0 CHECK (net_amount_cents >= 0),
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_no, version)
);

CREATE TABLE IF NOT EXISTS kristine.offer_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_no text NOT NULL REFERENCES kristine.offers(offer_no) ON DELETE RESTRICT,
  storage_path text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  document_role text NOT NULL DEFAULT 'approved-original'
    CHECK (document_role IN ('approved-original', 'approved-correction')),
  replaces_document_id bigint REFERENCES kristine.offer_documents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_no, sha256)
);

CREATE TABLE IF NOT EXISTS kristine.offer_acceptances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_no text NOT NULL UNIQUE REFERENCES kristine.offers(offer_no) ON DELETE RESTRICT,
  document_id bigint NOT NULL REFERENCES kristine.offer_documents(id) ON DELETE RESTRICT,
  accepted_name text NOT NULL,
  accepted_at timestamptz NOT NULL,
  payment_term text,
  requested_date date,
  client_ip_hash text,
  user_agent text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS kristine.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_key text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  source_import_id bigint REFERENCES kristine.source_imports(id),
  before_data jsonb,
  after_data jsonb,
  correlation_key text
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON kristine.audit_log (entity_type, entity_key, occurred_at DESC);

INSERT INTO kristine.schema_migrations (version, description)
VALUES ('001', 'Core jobs, employees, hours, offers and audit trail')
ON CONFLICT (version) DO NOTHING;

COMMIT;

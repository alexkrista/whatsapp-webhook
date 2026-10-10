-- Isolated test database first. No application-startup execution.

BEGIN;

ALTER TABLE kristine.document_versions ADD UNIQUE(company_id,id);

CREATE TABLE kristine.contact_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  person_party_id uuid NOT NULL,
  job_title text,
  active boolean NOT NULL DEFAULT true,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,person_party_id) REFERENCES kristine.parties(company_id,id),
  UNIQUE(company_id,person_party_id)
);

CREATE TABLE kristine.party_contact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  party_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'other',
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,party_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,contact_id) REFERENCES kristine.contact_people(company_id,id),
  UNIQUE(party_id,contact_id,role)
);

CREATE TABLE kristine.project_contact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  project_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'other',
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,contact_id) REFERENCES kristine.contact_people(company_id,id),
  UNIQUE(project_id,contact_id,role)
);

CREATE TABLE kristine.employee_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_id uuid NOT NULL,
  birth_date date,
  social_security_number text,
  collective_agreement_classification text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  UNIQUE(company_id,employee_id)
);

CREATE TABLE kristine.employee_employment_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date,
  employment_percent numeric(7,4) CHECK(employment_percent BETWEEN 0 AND 100),
  weekly_hours numeric(8,4) CHECK(weekly_hours >= 0),
  gross_monthly_salary numeric(20,4) CHECK(gross_monthly_salary >= 0),
  note text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK(ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE kristine.employee_clothing_sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_id uuid NOT NULL,
  garment text NOT NULL CHECK(garment IN ('tshirt','polo','pullover','jacket','trousers','shoes','gloves')),
  size text NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  UNIQUE(employee_id,garment)
);

CREATE TABLE kristine.employee_clothing_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_id uuid NOT NULL,
  issued_on date NOT NULL,
  item text NOT NULL,
  quantity numeric(12,4) NOT NULL CHECK(quantity > 0),
  note text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id)
);

CREATE TABLE kristine.employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('driving_license','passport','qualification','personnel','other')),
  valid_from date,
  valid_until date,
  title text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE TABLE kristine.employee_document_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  page_number integer NOT NULL CHECK(page_number > 0),
  page_role text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_document_id) REFERENCES kristine.employee_documents(company_id,id),
  FOREIGN KEY(company_id,document_version_id) REFERENCES kristine.document_versions(company_id,id),
  UNIQUE(employee_document_id,page_number)
);

CREATE TABLE kristine.employee_document_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  employee_document_id uuid NOT NULL,
  checked_on date NOT NULL,
  next_due_on date,
  checked_by_employee_id uuid,
  result text NOT NULL,
  note text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,employee_document_id) REFERENCES kristine.employee_documents(company_id,id),
  FOREIGN KEY(company_id,checked_by_employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK(next_due_on IS NULL OR next_due_on >= checked_on)
);

CREATE TABLE kristine.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  project_id uuid,
  title text NOT NULL CHECK(btrim(title) <> ''),
  task_type text NOT NULL DEFAULT 'other' CHECK(task_type IN ('callback','offer','problem','appointment','complaint','other','portal_request','goods_receipt')),
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','today','immediate')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','cancelled')),
  due_on date,
  creator_employee_id uuid,
  creator_name_snapshot text,
  legacy_assignee_name text,
  contact_name_snapshot text,
  contact_phone_snapshot text,
  contact_email_snapshot text,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,creator_employee_id) REFERENCES kristine.employees(company_id,id)
);

CREATE TABLE kristine.task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
  CHECK(released_at IS NULL OR released_at >= assigned_at)
);

CREATE UNIQUE INDEX task_one_active_assignee ON kristine.task_assignments(task_id) WHERE released_at IS NULL;

CREATE TABLE kristine.task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  author_employee_id uuid,
  author_name_snapshot text,
  body text NOT NULL CHECK(btrim(body) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  FOREIGN KEY(company_id,author_employee_id) REFERENCES kristine.employees(company_id,id)
);

CREATE TABLE kristine.task_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  location text,
  note text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  CHECK(ends_at IS NULL OR ends_at >= starts_at)
);

CREATE TABLE kristine.task_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  remind_at timestamptz NOT NULL,
  employee_id uuid,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id)
);

CREATE TABLE kristine.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  revision bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  UNIQUE(task_id,revision)
);

CREATE TABLE kristine.communication_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  channel text NOT NULL CHECK(channel IN ('email','whatsapp','portal','phone','note')),
  account_key text NOT NULL,
  display_name text,
  UNIQUE(company_id,id),
  UNIQUE(company_id,channel,account_key)
);

CREATE TABLE kristine.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  account_id uuid NOT NULL,
  provider_thread_id text,
  subject text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,account_id) REFERENCES kristine.communication_accounts(company_id,id),
  UNIQUE(account_id,provider_thread_id)
);

CREATE TABLE kristine.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  conversation_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound','outbound','internal')),
  sender_address text,
  sender_name text,
  subject text,
  body_text text,
  occurred_at timestamptz NOT NULL,
  original_document_version_id uuid,
  idempotency_key text NOT NULL CHECK(btrim(idempotency_key) <> ''),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,conversation_id) REFERENCES kristine.conversations(company_id,id),
  FOREIGN KEY(company_id,original_document_version_id) REFERENCES kristine.document_versions(company_id,id),
  UNIQUE(company_id,idempotency_key)
);

CREATE TABLE kristine.message_provider_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  FOREIGN KEY(company_id,account_id) REFERENCES kristine.communication_accounts(company_id,id),
  UNIQUE(account_id,provider_message_id)
);

CREATE TABLE kristine.message_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('to','cc','bcc')),
  address text NOT NULL,
  display_name text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  UNIQUE(message_id,role,address)
);

CREATE TABLE kristine.message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal > 0),
  filename text NOT NULL,
  is_inline boolean NOT NULL DEFAULT false,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  FOREIGN KEY(company_id,document_version_id) REFERENCES kristine.document_versions(company_id,id),
  UNIQUE(message_id,ordinal)
);

CREATE TABLE kristine.message_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','sent','delivered','read','failed')),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  detail text,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  UNIQUE(company_id,idempotency_key)
);

CREATE TABLE kristine.inbox_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid,
  original_document_version_id uuid,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','processing','processed','failed','ignored')),
  received_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  FOREIGN KEY(company_id,original_document_version_id) REFERENCES kristine.document_versions(company_id,id),
  CHECK(num_nonnulls(message_id,original_document_version_id) >= 1),
  UNIQUE(company_id,idempotency_key)
);

CREATE TABLE kristine.task_message_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  task_id uuid NOT NULL,
  message_id uuid NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  UNIQUE(task_id,message_id)
);

CREATE TABLE kristine.message_project_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  message_id uuid NOT NULL,
  project_id uuid NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  UNIQUE(message_id,project_id)
);

CREATE TABLE kristine.customer_portal_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
  UNIQUE(task_id)
);

CREATE TABLE kristine.customer_portal_point_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kristine.companies(id),
  point_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('submitted','sent','read','assigned','internal_done','customer_confirmed','customer_reopened','office_reopened','legacy_done')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  public_text text,
  idempotency_key text NOT NULL,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,point_id) REFERENCES kristine.customer_portal_points(company_id,id),
  UNIQUE(company_id,idempotency_key)
);

CREATE FUNCTION kristine.guard_provider_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.messages m JOIN kristine.conversations c ON c.id=m.conversation_id AND c.company_id=m.company_id WHERE m.company_id=NEW.company_id AND m.id=NEW.message_id AND c.account_id=NEW.account_id) THEN RAISE EXCEPTION 'Provider reference account mismatch'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER provider_account BEFORE INSERT ON kristine.message_provider_references FOR EACH ROW EXECUTE FUNCTION kristine.guard_provider_account();
CREATE TRIGGER provider_reference_immutable BEFORE UPDATE OR DELETE ON kristine.message_provider_references FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER provider_reference_no_truncate BEFORE TRUNCATE ON kristine.message_provider_references EXECUTE FUNCTION kristine.reject_history_change();
CREATE FUNCTION kristine.guard_conversation_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_id <> OLD.account_id AND EXISTS(SELECT 1 FROM kristine.messages WHERE conversation_id=OLD.id) THEN RAISE EXCEPTION 'Conversation account is immutable after messages'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER conversation_account BEFORE UPDATE OF account_id ON kristine.conversations FOR EACH ROW EXECUTE FUNCTION kristine.guard_conversation_account();
CREATE FUNCTION kristine.guard_contact_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.parties WHERE company_id=NEW.company_id AND id=NEW.person_party_id AND kind='person') THEN RAISE EXCEPTION 'Contact requires a person'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contact_person BEFORE INSERT OR UPDATE ON kristine.contact_people FOR EACH ROW EXECUTE FUNCTION kristine.guard_contact_person();
CREATE FUNCTION kristine.guard_contact_party_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind <> 'person' AND EXISTS(SELECT 1 FROM kristine.contact_people WHERE company_id=NEW.company_id AND person_party_id=NEW.id) THEN RAISE EXCEPTION 'Contact requires a person'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contact_party_kind BEFORE UPDATE OF kind ON kristine.parties FOR EACH ROW EXECUTE FUNCTION kristine.guard_contact_party_kind();
CREATE FUNCTION kristine.record_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'Task identity is immutable'; END IF;
  NEW.revision := OLD.revision+1;
 ELSE NEW.revision := 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_revision BEFORE INSERT OR UPDATE ON kristine.tasks FOR EACH ROW EXECUTE FUNCTION kristine.record_task_revision();
CREATE FUNCTION kristine.append_task_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO kristine.task_events(company_id,task_id,revision,snapshot) VALUES(NEW.company_id,NEW.id,NEW.revision,to_jsonb(NEW)); RETURN NEW;
END $$;
CREATE TRIGGER task_history AFTER INSERT OR UPDATE ON kristine.tasks FOR EACH ROW EXECUTE FUNCTION kristine.append_task_event();
CREATE FUNCTION kristine.guard_portal_point_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.tasks WHERE company_id=NEW.company_id AND id=NEW.task_id AND project_id=NEW.project_id) THEN RAISE EXCEPTION 'Portal point and task require the same project'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER portal_point_project BEFORE INSERT OR UPDATE ON kristine.customer_portal_points FOR EACH ROW EXECUTE FUNCTION kristine.guard_portal_point_project();
CREATE FUNCTION kristine.guard_portal_task_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM kristine.customer_portal_points WHERE task_id=OLD.id AND project_id IS DISTINCT FROM NEW.project_id) THEN RAISE EXCEPTION 'Portal point and task require the same project'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER portal_task_project BEFORE UPDATE OF project_id ON kristine.tasks FOR EACH ROW EXECUTE FUNCTION kristine.guard_portal_task_project();


CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON kristine.messages FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER messages_no_truncate BEFORE TRUNCATE ON kristine.messages EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER message_recipients_immutable BEFORE UPDATE OR DELETE ON kristine.message_recipients FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER message_recipients_no_truncate BEFORE TRUNCATE ON kristine.message_recipients EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER message_attachments_immutable BEFORE UPDATE OR DELETE ON kristine.message_attachments FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER message_attachments_no_truncate BEFORE TRUNCATE ON kristine.message_attachments EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER message_delivery_events_immutable BEFORE UPDATE OR DELETE ON kristine.message_delivery_events FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER message_delivery_events_no_truncate BEFORE TRUNCATE ON kristine.message_delivery_events EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON kristine.task_events FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER task_events_no_truncate BEFORE TRUNCATE ON kristine.task_events EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER task_comments_immutable BEFORE UPDATE OR DELETE ON kristine.task_comments FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER task_comments_no_truncate BEFORE TRUNCATE ON kristine.task_comments EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER employee_document_checks_immutable BEFORE UPDATE OR DELETE ON kristine.employee_document_checks FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER employee_document_checks_no_truncate BEFORE TRUNCATE ON kristine.employee_document_checks EXECUTE FUNCTION kristine.reject_history_change();

CREATE TRIGGER customer_portal_point_events_immutable BEFORE UPDATE OR DELETE ON kristine.customer_portal_point_events FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER customer_portal_point_events_no_truncate BEFORE TRUNCATE ON kristine.customer_portal_point_events EXECUTE FUNCTION kristine.reject_history_change();

ALTER TABLE kristine.external_references ADD COLUMN contact_id uuid, ADD COLUMN task_id uuid, ADD COLUMN message_id uuid, ADD COLUMN employee_document_id uuid, ADD COLUMN inbox_item_id uuid;

ALTER TABLE kristine.external_references DROP CONSTRAINT external_reference_one_target;

ALTER TABLE kristine.external_references ADD CONSTRAINT external_reference_one_target CHECK(num_nonnulls(party_id,employee_id,project_id,segment_id,document_id,offer_id,order_id,incoming_invoice_id,outgoing_invoice_id,product_id,regie_report_id,purchase_order_id,contact_id,task_id,message_id,employee_document_id,inbox_item_id)=1), ADD FOREIGN KEY(company_id,contact_id) REFERENCES kristine.contact_people(company_id,id), ADD FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id), ADD FOREIGN KEY(company_id,message_id) REFERENCES kristine.messages(company_id,id), ADD FOREIGN KEY(company_id,employee_document_id) REFERENCES kristine.employee_documents(company_id,id), ADD FOREIGN KEY(company_id,inbox_item_id) REFERENCES kristine.inbox_items(company_id,id);

COMMIT;

BEGIN;
ALTER TABLE kristine.time_events
 DROP CONSTRAINT time_events_origin_check,
 ADD CONSTRAINT time_events_origin_check CHECK(origin IN ('manual','automatic','whatsapp','kgo','legacy')),
 ADD COLUMN actual_local_time time,
 ADD COLUMN legacy_project_id text,
 ADD COLUMN import_review_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE kristine.external_references ADD COLUMN time_event_id uuid,
 ADD FOREIGN KEY(company_id,time_event_id) REFERENCES kristine.time_events(company_id,id),
 DROP CONSTRAINT external_reference_one_target,
 ADD CONSTRAINT external_reference_one_target CHECK(num_nonnulls(party_id,employee_id,project_id,segment_id,document_id,offer_id,order_id,incoming_invoice_id,outgoing_invoice_id,product_id,regie_report_id,purchase_order_id,contact_id,task_id,message_id,employee_document_id,inbox_item_id,address_id,contact_group_id,time_event_id)=1);
CREATE TABLE kristine.project_time_archive_days (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
 employee_id uuid NOT NULL, work_date date NOT NULL, legacy_id text NOT NULL,
 source_record_id uuid NOT NULL UNIQUE, source_version_id uuid NOT NULL,
 source_label text, released_at_original text, archived_at_original text,
 FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,legacy_id)
);
CREATE TABLE kristine.project_time_archive_segments (
 company_id uuid NOT NULL, day_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 legacy_id text, project_id uuid, legacy_project_id text,
 segment_type text NOT NULL, starts_local time NOT NULL, ends_local time,
 reason text, activity_mode text, billing_type text, unproductive_code text, absence_type text,
 import_review_reasons text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(day_id,position), CHECK(ends_local IS NULL OR ends_local>=starts_local), CHECK(ends_local IS NOT NULL OR 'end_time_missing'=ANY(import_review_reasons)),
 FOREIGN KEY(company_id,day_id) REFERENCES kristine.project_time_archive_days(company_id,id),
 FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id)
);
COMMIT;

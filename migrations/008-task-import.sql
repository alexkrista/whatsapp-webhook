BEGIN;
ALTER TABLE kristine.tasks
 ADD COLUMN note text,
 ADD COLUMN completed_at timestamptz,
 ADD COLUMN legacy_creator_id text,
 ADD COLUMN legacy_assignee_id text,
 ADD COLUMN legacy_project_id text,
 ADD COLUMN import_review_reasons text[] NOT NULL DEFAULT '{}';
CREATE TABLE kristine.task_local_appointments (
 company_id uuid NOT NULL, task_id uuid PRIMARY KEY,
 appointment_date date NOT NULL, starts_local time NOT NULL, ends_local time,
 calendar_owner text, calendar_account text,
 FOREIGN KEY(company_id,task_id) REFERENCES kristine.tasks(company_id,id),
 CHECK(ends_local IS NULL OR ends_local>=starts_local)
);
COMMIT;

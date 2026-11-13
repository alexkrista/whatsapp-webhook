BEGIN;
ALTER TABLE kristine.assignments
 ADD COLUMN source_record_id uuid,
 ADD COLUMN source_version_id uuid,
 ADD COLUMN legacy_project_id text,
 ADD COLUMN original_starts text,
 ADD COLUMN original_ends text,
 ADD COLUMN planned_hours numeric,
 ADD COLUMN note text,
 ADD COLUMN import_review_reasons text[] NOT NULL DEFAULT '{}',
 ADD CONSTRAINT assignment_source_fk FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 ADD CONSTRAINT assignment_version_fk FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 ADD CONSTRAINT assignment_source_unique UNIQUE(company_id,source_record_id);
ALTER TABLE kristine.absences
 ADD COLUMN source_record_id uuid,
 ADD COLUMN source_version_id uuid,
 ADD COLUMN reported_hours numeric,
 ADD CONSTRAINT absence_source_fk FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 ADD CONSTRAINT absence_version_fk FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 ADD CONSTRAINT absence_source_unique UNIQUE(company_id,source_record_id);
COMMIT;

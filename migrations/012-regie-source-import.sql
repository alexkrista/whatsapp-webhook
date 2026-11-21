BEGIN;
-- Exact legacy report archive. No new approval, billing or price completion.
CREATE TABLE kristine.imported_regie_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
 legacy_id text NOT NULL, project_id uuid, legacy_project_id text, report_number text,
 work_date date, date_original text, document_type_original text, status_original text,
 processing_status_original text, billing_status_original text, review_status_original text,
 description text, internal_note text, hourly_rate numeric, material_markup numeric,
 labor_hours numeric, labor_net numeric, material_net numeric, net_amount numeric, tax_amount numeric, gross_amount numeric,
 created_at_original text, updated_at_original text, completed_at_original text,
 price_pending boolean, source_record_id uuid NOT NULL, source_version_id uuid NOT NULL,
 import_review_reasons text[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
 FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,legacy_id), UNIQUE(company_id,source_record_id)
);
CREATE TABLE kristine.imported_regie_people (
 company_id uuid NOT NULL, report_id uuid NOT NULL, collection text NOT NULL CHECK(collection IN ('people','employees')),
 position integer NOT NULL CHECK(position>=0), employee_id uuid, legacy_employee_id text, name_original text,
 starts_original text, ends_original text, hours numeric, hourly_rate numeric, discount_percent numeric,
 raw_payload jsonb NOT NULL, import_review_reasons text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(report_id,collection,position),
 FOREIGN KEY(company_id,report_id) REFERENCES kristine.imported_regie_reports(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id)
);
CREATE TABLE kristine.imported_regie_materials (
 company_id uuid NOT NULL, report_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 legacy_material_id text, product_original text, supplier_original text, unit_original text,
 quantity numeric, purchase_price numeric, markup numeric, sale_price numeric, sale_price_gross numeric, net_amount numeric,
 raw_payload jsonb NOT NULL, import_review_reasons text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(report_id,position), FOREIGN KEY(company_id,report_id) REFERENCES kristine.imported_regie_reports(company_id,id)
);
CREATE TABLE kristine.imported_regie_attachments (
 company_id uuid NOT NULL, report_id uuid NOT NULL,
 collection text NOT NULL CHECK(collection IN ('photos','attachments')), position integer NOT NULL CHECK(position>=0),
 legacy_id text, name_original text, stored_name_original text, content_hash_original text, media_type_original text,
 raw_payload jsonb NOT NULL, PRIMARY KEY(report_id,collection,position),
 FOREIGN KEY(company_id,report_id) REFERENCES kristine.imported_regie_reports(company_id,id)
);
CREATE FUNCTION kristine.guard_imported_regie_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.id=NEW.source_record_id
 AND s.entity_type='imported_regie_report' AND s.external_id=NEW.legacy_id) THEN
 RAISE EXCEPTION 'Imported regie source mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER imported_regie_source_guard BEFORE INSERT ON kristine.imported_regie_reports FOR EACH ROW EXECUTE FUNCTION kristine.guard_imported_regie_source();
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imported_regie_reports','imported_regie_people','imported_regie_materials','imported_regie_attachments'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t||'_no_truncate',t);
 END LOOP;
END $$;
COMMIT;

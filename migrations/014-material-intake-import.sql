BEGIN;
CREATE TABLE kristine.imported_material_catalog (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
 source_path text NOT NULL, source_version_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 legacy_id text, material_code text, group_original text, subgroup_original text,
 manufacturer text, article_number text, product text, unit_original text, container_size_original text,
 purchase_price numeric, markup numeric, overhead numeric, sale_price numeric, fixed_sale_price numeric,
 stock_quantity numeric, minimum_stock numeric, storage_location text,
 legacy_supplier_id text, supplier_name text, supplier_article_number text,
 source_system text, source_id text, status_original text, active_original boolean,
 merged_into_legacy_id text, price_valid_from_original text, created_at_original text, updated_at_original text,
 raw_payload jsonb NOT NULL, import_review_reasons text[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,source_version_id,position)
);
CREATE TABLE kristine.imported_supplier_catalog (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_path text NOT NULL, source_version_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 legacy_id text, name_original text, ww_address_id text, ww_supplier_number text, our_customer_number text,
 aliases_original jsonb, address_original jsonb, updated_at_original text, raw_payload jsonb NOT NULL,
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,source_version_id,position)
);
CREATE TABLE kristine.imported_invoice_intake (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,
 source_path text NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position=0),
 legacy_id text,name_original text,stored_filename text,media_type_original text,byte_count_original numeric,
 file_sha256_original text,route_original text,status_original text,source_original text,
 submitted_by_legacy_id text,submitted_by_name text,payment_context_original jsonb,note_original text,
 captured_at_original text,created_at_original text,updated_at_original text,
 processed_at_original text,processed_by_original text,processed_doc_legacy_id text,
 deleted_at_original text,deleted_by_original text,delete_reason_original text,
 raw_payload jsonb NOT NULL,import_review_reasons text[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,source_version_id,position)
);
CREATE FUNCTION kristine.guard_catalog_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='json_file_snapshot' AND s.external_id=NEW.source_path) THEN RAISE EXCEPTION 'Catalog source mismatch'; END IF;
 RETURN NEW;
END $$;
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imported_material_catalog','imported_supplier_catalog','imported_invoice_intake'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.guard_catalog_source()',t||'_source_guard',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change()',t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON kristine.%I FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change()',t||'_no_truncate',t);
 END LOOP;
END $$;
COMMIT;

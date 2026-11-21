BEGIN;
CREATE TABLE kristine.imported_paint_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,source_path text NOT NULL,
 source_version_id uuid NOT NULL,collection text NOT NULL,position integer NOT NULL CHECK(position>=0),
 legacy_id text,colour_id text,colour_code text,product_id text,product_name text,
 formula_id text,base_id text,a_base_id text,base_code text,can_size_id text,can_id text,colorant_id text,
 status_original text,legacy_project_id text,quantity numeric,liters numeric,weight_kg numeric,net_amount numeric,purchase_price numeric,
 created_at_original text,updated_at_original text,mixed_at_original text,raw_payload jsonb NOT NULL,
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(company_id,source_version_id,collection,position)
);
CREATE INDEX imported_paint_source_key ON kristine.imported_paint_entries(company_id,collection,legacy_id);
CREATE INDEX imported_paint_formula_key ON kristine.imported_paint_entries(company_id,formula_id);
CREATE FUNCTION kristine.source_decimal(value text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN value ~ '^-?[0-9]+([.][0-9]+)?$' THEN value::numeric ELSE NULL END
$$;
CREATE TRIGGER imported_paint_source_guard BEFORE INSERT ON kristine.imported_paint_entries FOR EACH ROW EXECUTE FUNCTION kristine.guard_catalog_source();
CREATE TRIGGER imported_paint_immutable BEFORE UPDATE OR DELETE ON kristine.imported_paint_entries FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER imported_paint_no_truncate BEFORE TRUNCATE ON kristine.imported_paint_entries FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
COMMIT;

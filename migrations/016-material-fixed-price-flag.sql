BEGIN;
-- fixedSalePrice is a boolean switch, not a monetary amount. Preserve original
-- audit markers while deriving corrected source review and boolean projection.
ALTER TABLE kristine.imported_material_catalog ADD COLUMN fixed_sale_price_enabled boolean
 GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(raw_payload->'fixedSalePrice')='boolean'
 THEN (raw_payload->>'fixedSalePrice')::boolean ELSE NULL END) STORED;
ALTER TABLE kristine.imported_material_catalog ADD COLUMN source_review_reasons text[]
 GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(raw_payload->'fixedSalePrice')='boolean'
 THEN array_remove(import_review_reasons,'fixedSalePrice_invalid_number') ELSE import_review_reasons END) STORED;
COMMENT ON COLUMN kristine.imported_material_catalog.fixed_sale_price IS 'Legacy numeric projection only; a boolean fixedSalePrice must use fixed_sale_price_enabled. Not an additional sale price.';
COMMENT ON COLUMN kristine.imported_material_catalog.source_review_reasons IS 'Corrected source interpretation; original import classifications remain in import_review_reasons for audit.';
COMMIT;

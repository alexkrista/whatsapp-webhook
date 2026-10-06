BEGIN;
ALTER TABLE kristine.projects
  ADD COLUMN offer_outcome text CHECK (offer_outcome IS NULL OR offer_outcome = 'rejected'),
  ADD COLUMN import_review_reasons text[] NOT NULL DEFAULT '{}',
  ALTER COLUMN status DROP NOT NULL,
  ADD CONSTRAINT project_missing_status_review CHECK
    (status IS NOT NULL OR 'status_missing' = ANY(import_review_reasons)),
  ADD CONSTRAINT project_rejected_offer_status CHECK
    (offer_outcome IS NULL OR (status IS NOT NULL AND status = 1)),
  ADD CONSTRAINT project_empty_name_review CHECK
    (btrim(name) <> '' OR 'name_missing' = ANY(import_review_reasons));
COMMIT;

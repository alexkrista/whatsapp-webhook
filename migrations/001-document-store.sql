-- Explicit test-database migration only. Never applied on application startup.
BEGIN;
CREATE SCHEMA kristine_storage;
CREATE TABLE kristine_storage.documents (
    document_key text PRIMARY KEY CHECK (length(document_key) BETWEEN 1 AND 1024),
    payload jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE kristine_storage.documents IS
    'Compatibility storage for existing JSON structures. Keys preserve relative source paths. No automatic business-rule conversion.';
COMMIT;

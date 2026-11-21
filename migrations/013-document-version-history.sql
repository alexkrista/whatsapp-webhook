BEGIN;
CREATE TRIGGER document_version_immutable BEFORE UPDATE OR DELETE ON kristine.document_versions FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER document_version_no_truncate BEFORE TRUNCATE ON kristine.document_versions FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
COMMIT;

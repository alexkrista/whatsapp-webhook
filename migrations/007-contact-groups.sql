BEGIN;
CREATE TABLE kristine.contact_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES kristine.companies(id),
 display_name text NOT NULL CHECK(btrim(display_name)<>''), phone text, email text,
 import_review_reasons text[] NOT NULL DEFAULT '{}', UNIQUE(company_id,id)
);
CREATE TABLE kristine.contact_group_members (
 company_id uuid NOT NULL, group_id uuid NOT NULL, member_key text NOT NULL CHECK(btrim(member_key)<>''), party_id uuid NOT NULL,
 PRIMARY KEY(group_id,member_key),
 FOREIGN KEY(company_id,group_id) REFERENCES kristine.contact_groups(company_id,id),
 FOREIGN KEY(company_id,party_id) REFERENCES kristine.parties(company_id,id)
);
CREATE TABLE kristine.project_contact_group_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, project_id uuid NOT NULL, group_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','siteManager','architect')), source_version_id uuid NOT NULL,
 FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
 FOREIGN KEY(company_id,group_id) REFERENCES kristine.contact_groups(company_id,id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id),
 UNIQUE(project_id,group_id,role), UNIQUE(company_id,id)
);
ALTER TABLE kristine.external_references ADD COLUMN contact_group_id uuid,
 ADD FOREIGN KEY(company_id,contact_group_id) REFERENCES kristine.contact_groups(company_id,id),
 DROP CONSTRAINT external_reference_one_target,
 ADD CONSTRAINT external_reference_one_target CHECK(num_nonnulls(party_id,employee_id,project_id,segment_id,document_id,offer_id,order_id,incoming_invoice_id,outgoing_invoice_id,product_id,regie_report_id,purchase_order_id,contact_id,task_id,message_id,employee_document_id,inbox_item_id,address_id,contact_group_id)=1);
CREATE FUNCTION kristine.guard_project_contact_group_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM kristine.source_record_versions v
  JOIN kristine.source_records s ON s.id=v.source_record_id AND s.company_id=v.company_id
  JOIN kristine.external_references p ON p.source_record_id=s.id AND p.company_id=s.company_id
  JOIN kristine.source_records g ON g.company_id=s.company_id AND g.source_instance_id=s.source_instance_id AND g.entity_type='contact_group' AND g.external_id=v.raw_payload->'projectContacts'->NEW.role->>'masterContactId'
  JOIN kristine.external_references r ON r.source_record_id=g.id AND r.company_id=g.company_id
  WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='project' AND p.project_id=NEW.project_id AND r.contact_group_id=NEW.group_id
 ) THEN RAISE EXCEPTION 'Project contact group source mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_contact_group_source_guard BEFORE INSERT OR UPDATE ON kristine.project_contact_group_links FOR EACH ROW EXECUTE FUNCTION kristine.guard_project_contact_group_source();
COMMIT;

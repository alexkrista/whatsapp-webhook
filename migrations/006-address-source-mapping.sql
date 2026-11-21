BEGIN;
ALTER TABLE kristine.addresses ADD COLUMN house_number text, ADD COLUMN address_extra text;
ALTER TABLE kristine.external_references
 ADD COLUMN address_id uuid,
 ADD FOREIGN KEY(company_id,address_id) REFERENCES kristine.addresses(company_id,id),
 DROP CONSTRAINT external_reference_one_target,
 ADD CONSTRAINT external_reference_one_target CHECK(num_nonnulls(party_id,employee_id,project_id,segment_id,document_id,offer_id,order_id,incoming_invoice_id,outgoing_invoice_id,product_id,regie_report_id,purchase_order_id,contact_id,task_id,message_id,employee_document_id,inbox_item_id,address_id)=1);
COMMIT;

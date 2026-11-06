-- Second normalized domain block. Apply only to the isolated test database first.
BEGIN;
CREATE TABLE kristine.units (
  code text PRIMARY KEY CHECK (btrim(code) <> ''), name text NOT NULL
);
CREATE TABLE kristine.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES kristine.companies(id),
  sku text NOT NULL, name text NOT NULL, stock_unit text NOT NULL REFERENCES kristine.units(code),
  active boolean NOT NULL DEFAULT true, UNIQUE(company_id,sku), UNIQUE(company_id,id)
);
CREATE TABLE kristine.supplier_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  supplier_id uuid NOT NULL, product_id uuid NOT NULL, supplier_sku text NOT NULL,
  purchase_unit text NOT NULL REFERENCES kristine.units(code),
  stock_units_per_purchase_unit numeric(20,6) NOT NULL CHECK(stock_units_per_purchase_unit > 0),
  FOREIGN KEY(company_id,supplier_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  UNIQUE(company_id,supplier_id,supplier_sku), UNIQUE(company_id,id)
);
CREATE TABLE kristine.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  supplier_product_id uuid NOT NULL, effective_on date NOT NULL,
  unit_price numeric(20,6) NOT NULL CHECK(unit_price >= 0),
  price_per_quantity numeric(20,6) NOT NULL CHECK(price_per_quantity > 0),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  source_record_id uuid, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,supplier_product_id) REFERENCES kristine.supplier_products(company_id,id),
  FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  project_id uuid NOT NULL, customer_id uuid NOT NULL,
  offer_number text NOT NULL, version integer NOT NULL CHECK(version > 0), issued_on date,
  status text NOT NULL CHECK(status IN ('draft','sent','accepted','rejected','archived')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  price_mode text NOT NULL CHECK(price_mode IN ('net','gross')),
  discount_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
  net_amount numeric(20,4) NOT NULL, tax_amount numeric(20,4) NOT NULL, gross_amount numeric(20,4) NOT NULL,
  payment_terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES kristine.parties(company_id,id),
  CHECK(gross_amount = net_amount + tax_amount), UNIQUE(company_id,offer_number,version), UNIQUE(company_id,id)
);
CREATE TABLE kristine.offer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, offer_id uuid NOT NULL,
  position_number text NOT NULL, group_name text, description text NOT NULL,
  quantity numeric(20,6) NOT NULL, unit text REFERENCES kristine.units(code),
  entered_unit_price numeric(20,6) NOT NULL, net_unit_price numeric(20,6) NOT NULL,
  group_discount_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK(group_discount_percent BETWEEN 0 AND 100),
  net_amount numeric(20,4) NOT NULL, tax_rate numeric(7,4) NOT NULL CHECK(tax_rate BETWEEN 0 AND 100),
  alternative_group text, selected boolean NOT NULL DEFAULT true,
  labor_hours_per_unit numeric(20,6),
  FOREIGN KEY(company_id,offer_id) REFERENCES kristine.offers(company_id,id),
  UNIQUE(offer_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  project_id uuid NOT NULL, customer_id uuid NOT NULL, source_offer_id uuid,
  order_number text NOT NULL, ordered_on date NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','confirmed','running','completed','cancelled','archived')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  net_amount numeric(20,4) NOT NULL, tax_amount numeric(20,4) NOT NULL, gross_amount numeric(20,4) NOT NULL,
  payment_terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,source_offer_id) REFERENCES kristine.offers(company_id,id),
  CHECK(gross_amount = net_amount + tax_amount), UNIQUE(company_id,order_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, order_id uuid NOT NULL,
  position_number text NOT NULL, description text NOT NULL,
  quantity numeric(20,6) NOT NULL, unit text REFERENCES kristine.units(code),
  net_unit_price numeric(20,6) NOT NULL, net_amount numeric(20,4) NOT NULL,
  tax_rate numeric(7,4) NOT NULL CHECK(tax_rate BETWEEN 0 AND 100), labor_hours_per_unit numeric(20,6),
  FOREIGN KEY(company_id,order_id) REFERENCES kristine.orders(company_id,id),
  UNIQUE(order_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.order_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, order_id uuid NOT NULL,
  starts_on date NOT NULL, ends_on date NOT NULL,
  status text NOT NULL CHECK(status IN ('requested','proposed','confirmed','declined')),
  FOREIGN KEY(company_id,order_id) REFERENCES kristine.orders(company_id,id),
  CHECK(ends_on >= starts_on), UNIQUE(company_id,id)
);
CREATE TABLE kristine.outgoing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, customer_id uuid NOT NULL, project_id uuid,
  invoice_number text NOT NULL, issued_on date NOT NULL, due_on date,
  kind text NOT NULL CHECK(kind IN ('invoice','credit_note','prepayment','partial','final')),
  document_status text NOT NULL CHECK(document_status IN ('draft','issued','cancelled','archived')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  net_amount numeric(20,4) NOT NULL CHECK(net_amount >= 0),
  tax_amount numeric(20,4) NOT NULL CHECK(tax_amount >= 0),
  gross_amount numeric(20,4) NOT NULL CHECK(gross_amount = net_amount + tax_amount),
  payment_terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY(company_id,customer_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  UNIQUE(company_id,invoice_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.outgoing_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, invoice_id uuid NOT NULL,
  position_number text NOT NULL, description text NOT NULL,
  quantity numeric(20,6) NOT NULL, unit text REFERENCES kristine.units(code),
  net_unit_price numeric(20,6) NOT NULL, net_amount numeric(20,4) NOT NULL,
  tax_rate numeric(7,4) NOT NULL CHECK(tax_rate BETWEEN 0 AND 100), tax_amount numeric(20,4) NOT NULL,
  FOREIGN KEY(company_id,invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id),
  UNIQUE(invoice_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.invoice_order_links (
  company_id uuid NOT NULL, invoice_id uuid NOT NULL, order_id uuid NOT NULL,
  net_allocation numeric(20,4) NOT NULL, PRIMARY KEY(invoice_id,order_id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id),
  FOREIGN KEY(company_id,order_id) REFERENCES kristine.orders(company_id,id)
);
CREATE TABLE kristine.incoming_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, supplier_id uuid NOT NULL, project_id uuid,
  invoice_number text NOT NULL, issued_on date NOT NULL, due_on date,
  kind text NOT NULL CHECK(kind IN ('invoice','credit_note','prepayment','partial','final')),
  document_status text NOT NULL CHECK(document_status IN ('draft','issued','cancelled','archived')),
  payment_method text NOT NULL CHECK(payment_method IN ('transfer','direct_debit','revolut','card','cash','other')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  net_amount numeric(20,4) NOT NULL CHECK(net_amount >= 0), tax_amount numeric(20,4) NOT NULL CHECK(tax_amount >= 0),
  gross_amount numeric(20,4) NOT NULL CHECK(gross_amount = net_amount + tax_amount),
  payment_terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY(company_id,supplier_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  UNIQUE(company_id,supplier_id,invoice_number,issued_on,kind), UNIQUE(company_id,id)
);
CREATE TABLE kristine.incoming_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, invoice_id uuid NOT NULL, product_id uuid,
  position_number text NOT NULL, description text NOT NULL,
  quantity numeric(20,6) NOT NULL, unit text REFERENCES kristine.units(code),
  net_unit_price numeric(20,6) NOT NULL, net_amount numeric(20,4) NOT NULL,
  tax_rate numeric(7,4) NOT NULL CHECK(tax_rate BETWEEN 0 AND 100), tax_amount numeric(20,4) NOT NULL,
  FOREIGN KEY(company_id,invoice_id) REFERENCES kristine.incoming_invoices(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  UNIQUE(invoice_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, document_id uuid NOT NULL,
  incoming_invoice_id uuid, outgoing_invoice_id uuid,
  FOREIGN KEY(company_id,document_id) REFERENCES kristine.documents(company_id,id),
  FOREIGN KEY(company_id,incoming_invoice_id) REFERENCES kristine.incoming_invoices(company_id,id),
  FOREIGN KEY(company_id,outgoing_invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id),
  CHECK(num_nonnulls(incoming_invoice_id,outgoing_invoice_id)=1),
  UNIQUE(document_id,incoming_invoice_id), UNIQUE(document_id,outgoing_invoice_id)
);
CREATE TABLE kristine.financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES kristine.companies(id),
  name text NOT NULL, kind text NOT NULL CHECK(kind IN ('bank','revolut','cash')),
  iban text, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), UNIQUE(company_id,id)
);
CREATE TABLE kristine.bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, account_id uuid NOT NULL,
  external_id text NOT NULL, booked_on date NOT NULL,
  amount numeric(20,4) NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  original_amount numeric(20,4), original_currency text CHECK(original_currency ~ '^[A-Z]{3}$'),
  merchant text, reference text, end_to_end_id text, source_record_id uuid NOT NULL,
  FOREIGN KEY(company_id,account_id) REFERENCES kristine.financial_accounts(company_id,id),
  FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
  CHECK((original_amount IS NULL) = (original_currency IS NULL)),
  CHECK(original_amount IS NULL OR (original_amount > 0) = (amount > 0)),
  UNIQUE(account_id,external_id), UNIQUE(source_record_id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.bank_transaction_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, transaction_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('unclassified','revenue','expense','internal_transfer','owner_contribution','other')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), note text,
  FOREIGN KEY(company_id,transaction_id) REFERENCES kristine.bank_transactions(company_id,id)
);
CREATE TABLE kristine.payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, account_id uuid NOT NULL,
  transfer_speed text NOT NULL CHECK(transfer_speed IN ('normal','instant')),
  status text NOT NULL CHECK(status IN ('draft','exported','submitted','cancelled')),
  exported_document_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,account_id) REFERENCES kristine.financial_accounts(company_id,id),
  FOREIGN KEY(company_id,exported_document_id) REFERENCES kristine.documents(company_id,id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, account_id uuid NOT NULL,
  batch_id uuid, bank_transaction_id uuid,
  direction text NOT NULL CHECK(direction IN ('incoming','outgoing')),
  method text NOT NULL CHECK(method IN ('transfer','direct_debit','revolut','card','cash','other')),
  status text NOT NULL CHECK(status IN ('planned','submitted','settled','cancelled')),
  amount numeric(20,4) NOT NULL CHECK(amount > 0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  end_to_end_id text,
  FOREIGN KEY(company_id,account_id) REFERENCES kristine.financial_accounts(company_id,id),
  FOREIGN KEY(company_id,batch_id) REFERENCES kristine.payment_batches(company_id,id),
  FOREIGN KEY(company_id,bank_transaction_id) REFERENCES kristine.bank_transactions(company_id,id),
  CHECK(status <> 'settled' OR bank_transaction_id IS NOT NULL),
  UNIQUE(bank_transaction_id), UNIQUE(company_id,end_to_end_id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, payment_id uuid NOT NULL,
  incoming_invoice_id uuid, outgoing_invoice_id uuid,
  allocated_amount numeric(20,4) NOT NULL CHECK(allocated_amount > 0),
  discount_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
  FOREIGN KEY(company_id,payment_id) REFERENCES kristine.payments(company_id,id),
  FOREIGN KEY(company_id,incoming_invoice_id) REFERENCES kristine.incoming_invoices(company_id,id),
  FOREIGN KEY(company_id,outgoing_invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id),
  CHECK(num_nonnulls(incoming_invoice_id,outgoing_invoice_id)=1),
  UNIQUE(payment_id,incoming_invoice_id), UNIQUE(payment_id,outgoing_invoice_id)
);
CREATE TABLE kristine.payment_allocation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  allocation_id uuid NOT NULL, operation text NOT NULL,
  record jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), recorded_by text NOT NULL DEFAULT session_user
);
CREATE TABLE kristine.regie_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, project_id uuid NOT NULL,
  report_number text NOT NULL, work_date date NOT NULL, description text NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','submitted','approved','billed','archived')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  labor_net numeric(20,4) NOT NULL, material_net numeric(20,4) NOT NULL,
  tax_amount numeric(20,4) NOT NULL, gross_amount numeric(20,4) NOT NULL,
  signature_document_id uuid,
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,signature_document_id) REFERENCES kristine.documents(company_id,id),
  CHECK(gross_amount = labor_net + material_net + tax_amount), UNIQUE(project_id,report_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.regie_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, report_id uuid NOT NULL, employee_id uuid,
  employee_name_snapshot text NOT NULL,
  hours numeric(20,6) NOT NULL CHECK(hours >= 0), hourly_rate numeric(20,6) NOT NULL CHECK(hourly_rate >= 0), labor_net numeric(20,4) NOT NULL,
  FOREIGN KEY(company_id,report_id) REFERENCES kristine.regie_reports(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES kristine.employees(company_id,id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.regie_material_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, report_id uuid NOT NULL, product_id uuid,
  description_snapshot text NOT NULL, quantity numeric(20,6) NOT NULL, unit text REFERENCES kristine.units(code),
  net_unit_price numeric(20,6) NOT NULL, net_amount numeric(20,4) NOT NULL,
  FOREIGN KEY(company_id,report_id) REFERENCES kristine.regie_reports(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id), UNIQUE(company_id,id)
);
CREATE TABLE kristine.regie_invoice_links (
  company_id uuid NOT NULL, report_id uuid NOT NULL, invoice_id uuid NOT NULL,
  PRIMARY KEY(report_id,invoice_id),
  FOREIGN KEY(company_id,report_id) REFERENCES kristine.regie_reports(company_id,id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id)
);
CREATE TABLE kristine.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, supplier_id uuid NOT NULL, project_id uuid,
  order_number text NOT NULL, ordered_on date NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','sent','received','cancelled','archived')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  FOREIGN KEY(company_id,supplier_id) REFERENCES kristine.parties(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  UNIQUE(company_id,order_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, purchase_order_id uuid NOT NULL, product_id uuid NOT NULL,
  position_number text NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity > 0),
  purchase_unit text NOT NULL REFERENCES kristine.units(code),
  stock_units_per_purchase_unit numeric(20,6) NOT NULL CHECK(stock_units_per_purchase_unit > 0),
  net_unit_price numeric(20,6) NOT NULL CHECK(net_unit_price >= 0),
  FOREIGN KEY(company_id,purchase_order_id) REFERENCES kristine.purchase_orders(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  UNIQUE(purchase_order_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES kristine.companies(id),
  name text NOT NULL, UNIQUE(company_id,name), UNIQUE(company_id,id)
);
CREATE TABLE kristine.goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  incoming_invoice_id uuid, purchase_order_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0), received_on date NOT NULL,
  confirmed_at timestamptz, confirmed_by text,
  FOREIGN KEY(company_id,warehouse_id) REFERENCES kristine.warehouses(company_id,id),
  FOREIGN KEY(company_id,incoming_invoice_id) REFERENCES kristine.incoming_invoices(company_id,id),
  FOREIGN KEY(company_id,purchase_order_id) REFERENCES kristine.purchase_orders(company_id,id),
  CHECK((status='pending' AND confirmed_at IS NULL AND confirmed_by IS NULL) OR (status='confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  UNIQUE(company_id,id)
);
CREATE TABLE kristine.goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, receipt_id uuid NOT NULL, product_id uuid NOT NULL,
  position_number text NOT NULL, stock_quantity numeric(20,6) NOT NULL CHECK(stock_quantity > 0),
  stock_unit text NOT NULL REFERENCES kristine.units(code),
  incoming_invoice_line_id uuid, purchase_order_line_id uuid,
  FOREIGN KEY(company_id,receipt_id) REFERENCES kristine.goods_receipts(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  FOREIGN KEY(company_id,incoming_invoice_line_id) REFERENCES kristine.incoming_invoice_lines(company_id,id),
  FOREIGN KEY(company_id,purchase_order_line_id) REFERENCES kristine.purchase_order_lines(company_id,id),
  UNIQUE(receipt_id,position_number), UNIQUE(company_id,id)
);
CREATE TABLE kristine.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, warehouse_id uuid NOT NULL, product_id uuid NOT NULL,
  stock_unit text NOT NULL REFERENCES kristine.units(code), delta numeric(20,6) NOT NULL CHECK(delta <> 0),
  reason text NOT NULL CHECK(reason IN ('opening','goods_received','consumption','return','adjustment')),
  idempotency_key text NOT NULL, receipt_line_id uuid, project_id uuid, source_record_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(company_id,warehouse_id) REFERENCES kristine.warehouses(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  FOREIGN KEY(company_id,receipt_line_id) REFERENCES kristine.goods_receipt_lines(company_id,id),
  FOREIGN KEY(company_id,project_id) REFERENCES kristine.projects(company_id,id),
  FOREIGN KEY(company_id,source_record_id) REFERENCES kristine.source_records(company_id,id),
  CHECK((reason='goods_received') = (receipt_line_id IS NOT NULL)),
  CHECK(reason <> 'goods_received' OR delta > 0), CHECK(reason <> 'consumption' OR delta < 0),
  UNIQUE(company_id,idempotency_key), UNIQUE(receipt_line_id)
);

ALTER TABLE kristine.external_references ADD COLUMN offer_id uuid, ADD COLUMN order_id uuid,
  ADD COLUMN incoming_invoice_id uuid, ADD COLUMN outgoing_invoice_id uuid, ADD COLUMN product_id uuid,
  ADD COLUMN regie_report_id uuid, ADD COLUMN purchase_order_id uuid;
ALTER TABLE kristine.external_references DROP CONSTRAINT external_references_check;
ALTER TABLE kristine.external_references ADD CONSTRAINT external_reference_one_target CHECK(num_nonnulls(party_id,employee_id,project_id,segment_id,document_id,offer_id,order_id,incoming_invoice_id,outgoing_invoice_id,product_id,regie_report_id,purchase_order_id)=1),
  ADD FOREIGN KEY(company_id,offer_id) REFERENCES kristine.offers(company_id,id),
  ADD FOREIGN KEY(company_id,order_id) REFERENCES kristine.orders(company_id,id),
  ADD FOREIGN KEY(company_id,incoming_invoice_id) REFERENCES kristine.incoming_invoices(company_id,id),
  ADD FOREIGN KEY(company_id,outgoing_invoice_id) REFERENCES kristine.outgoing_invoices(company_id,id),
  ADD FOREIGN KEY(company_id,product_id) REFERENCES kristine.products(company_id,id),
  ADD FOREIGN KEY(company_id,regie_report_id) REFERENCES kristine.regie_reports(company_id,id),
  ADD FOREIGN KEY(company_id,purchase_order_id) REFERENCES kristine.purchase_orders(company_id,id);

CREATE FUNCTION kristine.guard_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE b kristine.bank_transactions%ROWTYPE; batch kristine.payment_batches%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.status='settled' THEN RAISE EXCEPTION 'Settled payment is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.batch_id IS NOT NULL THEN
    SELECT * INTO STRICT batch FROM kristine.payment_batches WHERE id=NEW.batch_id;
    IF batch.company_id<>NEW.company_id OR batch.account_id<>NEW.account_id OR NEW.method<>'transfer' THEN RAISE EXCEPTION 'Payment batch mismatch'; END IF;
  END IF;
  IF NEW.status='settled' THEN
    SELECT * INTO STRICT b FROM kristine.bank_transactions WHERE id=NEW.bank_transaction_id;
    IF b.company_id<>NEW.company_id OR b.account_id<>NEW.account_id OR coalesce(b.original_currency,b.currency)<>NEW.currency OR abs(coalesce(b.original_amount,b.amount))<>NEW.amount OR (coalesce(b.original_amount,b.amount)>0)<>(NEW.direction='incoming') THEN RAISE EXCEPTION 'Payment does not match booked transaction'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.amount<>OLD.amount OR NEW.currency<>OLD.currency OR NEW.direction<>OLD.direction OR NEW.company_id<>OLD.company_id OR NEW.id<>OLD.id) AND EXISTS(SELECT 1 FROM kristine.payment_allocations WHERE payment_id=OLD.id) THEN RAISE EXCEPTION 'Allocated payment identity/amount is immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='cancelled' AND NEW.status<>'cancelled' AND EXISTS(SELECT 1 FROM kristine.payment_allocations WHERE payment_id=OLD.id) THEN RAISE EXCEPTION 'Remove cancelled allocations before reactivating payment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.payments FOR EACH ROW EXECUTE FUNCTION kristine.guard_payment();
CREATE FUNCTION kristine.guard_allocated_invoice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE allocated boolean;
BEGIN
  IF TG_TABLE_NAME='incoming_invoices' THEN SELECT EXISTS(SELECT 1 FROM kristine.payment_allocations WHERE incoming_invoice_id=OLD.id) INTO allocated;
  ELSE SELECT EXISTS(SELECT 1 FROM kristine.payment_allocations WHERE outgoing_invoice_id=OLD.id) INTO allocated; END IF;
  IF allocated AND (ROW(NEW.id,NEW.company_id,NEW.currency,NEW.kind,NEW.gross_amount) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.currency,OLD.kind,OLD.gross_amount) OR NEW.document_status IN ('draft','cancelled') OR (to_jsonb(NEW)->'supplier_id') IS DISTINCT FROM (to_jsonb(OLD)->'supplier_id') OR (to_jsonb(NEW)->'customer_id') IS DISTINCT FROM (to_jsonb(OLD)->'customer_id')) THEN RAISE EXCEPTION 'Allocated invoice financial identity/status is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER incoming_allocated_guard BEFORE UPDATE ON kristine.incoming_invoices FOR EACH ROW EXECUTE FUNCTION kristine.guard_allocated_invoice();
CREATE TRIGGER outgoing_allocated_guard BEFORE UPDATE ON kristine.outgoing_invoices FOR EACH ROW EXECUTE FUNCTION kristine.guard_allocated_invoice();
CREATE FUNCTION kristine.guard_bank_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE a kristine.financial_accounts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT a FROM kristine.financial_accounts WHERE id=NEW.account_id;
  IF a.company_id<>NEW.company_id OR a.currency<>NEW.currency THEN RAISE EXCEPTION 'Bank account currency/company mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_transaction_guard BEFORE INSERT ON kristine.bank_transactions FOR EACH ROW EXECUTE FUNCTION kristine.guard_bank_transaction();

CREATE FUNCTION kristine.guard_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE p kristine.payments%ROWTYPE; c text; amount_due numeric; invoice_kind text; invoice_status text; already numeric; expected_direction text;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.company_id,NEW.payment_id,NEW.incoming_invoice_id,NEW.outgoing_invoice_id) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.payment_id,OLD.incoming_invoice_id,OLD.outgoing_invoice_id) THEN RAISE EXCEPTION 'Allocation identity is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM kristine.payments WHERE id=OLD.payment_id FOR UPDATE;
    RETURN OLD;
  END IF;
  SELECT * INTO STRICT p FROM kristine.payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.company_id<>NEW.company_id OR p.status='cancelled' THEN RAISE EXCEPTION 'Allocation payment mismatch'; END IF;
  IF NEW.incoming_invoice_id IS NOT NULL THEN
    SELECT currency,gross_amount,kind,document_status INTO STRICT c,amount_due,invoice_kind,invoice_status FROM kristine.incoming_invoices WHERE id=NEW.incoming_invoice_id AND company_id=NEW.company_id FOR UPDATE;
    expected_direction := CASE WHEN invoice_kind='credit_note' THEN 'incoming' ELSE 'outgoing' END;
    SELECT coalesce(sum(a.allocated_amount+a.discount_amount),0) INTO already FROM kristine.payment_allocations a JOIN kristine.payments other ON other.id=a.payment_id WHERE a.incoming_invoice_id=NEW.incoming_invoice_id AND a.id<>NEW.id AND other.status<>'cancelled';
  ELSE
    SELECT currency,gross_amount,kind,document_status INTO STRICT c,amount_due,invoice_kind,invoice_status FROM kristine.outgoing_invoices WHERE id=NEW.outgoing_invoice_id AND company_id=NEW.company_id FOR UPDATE;
    expected_direction := CASE WHEN invoice_kind='credit_note' THEN 'outgoing' ELSE 'incoming' END;
    SELECT coalesce(sum(a.allocated_amount+a.discount_amount),0) INTO already FROM kristine.payment_allocations a JOIN kristine.payments other ON other.id=a.payment_id WHERE a.outgoing_invoice_id=NEW.outgoing_invoice_id AND a.id<>NEW.id AND other.status<>'cancelled';
  END IF;
  IF p.currency<>c OR p.direction<>expected_direction OR invoice_status IN ('draft','cancelled') THEN RAISE EXCEPTION 'Invoice currency/direction/status mismatch'; END IF;
  IF already+NEW.allocated_amount+NEW.discount_amount>amount_due THEN RAISE EXCEPTION 'Invoice over-allocation'; END IF;
  SELECT coalesce(sum(allocated_amount),0) INTO already FROM kristine.payment_allocations WHERE payment_id=NEW.payment_id AND id<>NEW.id;
  IF already+NEW.allocated_amount>p.amount THEN RAISE EXCEPTION 'Payment over-allocation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.payment_allocations FOR EACH ROW EXECUTE FUNCTION kristine.guard_allocation();
CREATE FUNCTION kristine.audit_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
BEGIN
  IF TG_OP='DELETE' THEN INSERT INTO kristine.payment_allocation_events(company_id,allocation_id,operation,record) VALUES(OLD.company_id,OLD.id,TG_OP,to_jsonb(OLD)); RETURN OLD; END IF;
  INSERT INTO kristine.payment_allocation_events(company_id,allocation_id,operation,record) VALUES(NEW.company_id,NEW.id,TG_OP,to_jsonb(NEW)); RETURN NEW;
END $$;
CREATE TRIGGER allocation_audit AFTER INSERT OR UPDATE OR DELETE ON kristine.payment_allocations FOR EACH ROW EXECUTE FUNCTION kristine.audit_allocation();

CREATE VIEW kristine.incoming_invoice_settlement AS
SELECT i.id,i.company_id,i.currency,i.gross_amount,
  coalesce(sum(a.allocated_amount+a.discount_amount) FILTER(WHERE p.status='settled'),0) AS settled_gross,
  i.gross_amount-coalesce(sum(a.allocated_amount+a.discount_amount) FILTER(WHERE p.status='settled'),0) AS outstanding_gross,
  CASE WHEN i.gross_amount>0 AND coalesce(sum(a.allocated_amount+a.discount_amount) FILTER(WHERE p.status='settled'),0)>=i.gross_amount THEN 'paid'
       WHEN bool_or(p.status='submitted' AND p.method='transfer') THEN 'sepa_handed' ELSE 'open' END AS settlement_status
FROM kristine.incoming_invoices i LEFT JOIN kristine.payment_allocations a ON a.incoming_invoice_id=i.id LEFT JOIN kristine.payments p ON p.id=a.payment_id GROUP BY i.id;
CREATE VIEW kristine.outgoing_invoice_settlement AS
SELECT i.id,i.company_id,i.currency,i.gross_amount,
  coalesce(sum(a.allocated_amount+a.discount_amount) FILTER(WHERE p.status='settled'),0) AS settled_gross,
  i.gross_amount-coalesce(sum(a.allocated_amount+a.discount_amount) FILTER(WHERE p.status='settled'),0) AS outstanding_gross
FROM kristine.outgoing_invoices i LEFT JOIN kristine.payment_allocations a ON a.outgoing_invoice_id=i.id LEFT JOIN kristine.payments p ON p.id=a.payment_id GROUP BY i.id;

CREATE FUNCTION kristine.guard_receipt_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE r kristine.goods_receipts%ROWTYPE; product kristine.products%ROWTYPE; il kristine.incoming_invoice_lines%ROWTYPE; pl kristine.purchase_order_lines%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.company_id,NEW.receipt_id) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.receipt_id) THEN RAISE EXCEPTION 'Receipt line identity is immutable'; END IF;
  IF TG_OP='DELETE' THEN SELECT * INTO STRICT r FROM kristine.goods_receipts WHERE id=OLD.receipt_id FOR UPDATE;
  ELSE SELECT * INTO STRICT r FROM kristine.goods_receipts WHERE id=NEW.receipt_id FOR UPDATE; END IF;
  IF r.status='confirmed' THEN RAISE EXCEPTION 'Confirmed receipt lines are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO STRICT product FROM kristine.products WHERE id=NEW.product_id;
  IF product.company_id<>NEW.company_id OR r.company_id<>NEW.company_id OR product.stock_unit<>NEW.stock_unit THEN RAISE EXCEPTION 'Receipt product/unit mismatch'; END IF;
  IF NEW.incoming_invoice_line_id IS NOT NULL THEN
    SELECT * INTO STRICT il FROM kristine.incoming_invoice_lines WHERE id=NEW.incoming_invoice_line_id;
    IF il.invoice_id IS DISTINCT FROM r.incoming_invoice_id OR il.product_id IS DISTINCT FROM NEW.product_id THEN RAISE EXCEPTION 'Receipt invoice line mismatch'; END IF;
  END IF;
  IF NEW.purchase_order_line_id IS NOT NULL THEN
    SELECT * INTO STRICT pl FROM kristine.purchase_order_lines WHERE id=NEW.purchase_order_line_id;
    IF pl.purchase_order_id IS DISTINCT FROM r.purchase_order_id OR pl.product_id<>NEW.product_id THEN RAISE EXCEPTION 'Receipt order line mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_line_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION kristine.guard_receipt_line();
CREATE FUNCTION kristine.guard_stock_movement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE product kristine.products%ROWTYPE; line kristine.goods_receipt_lines%ROWTYPE; r kristine.goods_receipts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT product FROM kristine.products WHERE id=NEW.product_id;
  IF product.company_id<>NEW.company_id OR product.stock_unit<>NEW.stock_unit THEN RAISE EXCEPTION 'Stock unit mismatch'; END IF;
  IF NEW.reason='goods_received' THEN
    SELECT * INTO STRICT line FROM kristine.goods_receipt_lines WHERE id=NEW.receipt_line_id;
    SELECT * INTO STRICT r FROM kristine.goods_receipts WHERE id=line.receipt_id FOR UPDATE;
    IF r.status<>'confirmed' OR ROW(NEW.company_id,NEW.warehouse_id,NEW.product_id,NEW.stock_unit,NEW.delta) IS DISTINCT FROM ROW(r.company_id,r.warehouse_id,line.product_id,line.stock_unit,line.stock_quantity) THEN RAISE EXCEPTION 'Stock receipt is not confirmed or mismatched'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_guard BEFORE INSERT ON kristine.stock_movements FOR EACH ROW EXECUTE FUNCTION kristine.guard_stock_movement();
CREATE FUNCTION kristine.guard_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE po kristine.purchase_orders%ROWTYPE; supplier uuid;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.status='confirmed' THEN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Confirmed receipt is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='INSERT' AND NEW.status<>'pending' THEN RAISE EXCEPTION 'Receipt starts pending'; END IF;
  IF NEW.purchase_order_id IS NOT NULL THEN
    SELECT * INTO STRICT po FROM kristine.purchase_orders WHERE id=NEW.purchase_order_id FOR UPDATE;
    IF NEW.incoming_invoice_id IS NOT NULL THEN
      SELECT supplier_id INTO STRICT supplier FROM kristine.incoming_invoices WHERE id=NEW.incoming_invoice_id;
      IF supplier<>po.supplier_id THEN RAISE EXCEPTION 'Receipt supplier mismatch'; END IF;
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.company_id,NEW.warehouse_id,NEW.incoming_invoice_id,NEW.purchase_order_id) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.warehouse_id,OLD.incoming_invoice_id,OLD.purchase_order_id) THEN RAISE EXCEPTION 'Receipt references are immutable; replace pending receipt'; END IF;
    IF NEW.status='confirmed' AND NOT EXISTS(SELECT 1 FROM kristine.goods_receipt_lines WHERE receipt_id=NEW.id) THEN RAISE EXCEPTION 'Empty receipt cannot be confirmed'; END IF;
    IF NEW.status='confirmed' AND NEW.purchase_order_id IS NOT NULL THEN
      IF po.status IN ('received','cancelled','archived') THEN RAISE EXCEPTION 'Purchase order is already closed'; END IF;
      IF EXISTS(
        SELECT 1 FROM (SELECT product_id,sum(stock_quantity) AS quantity FROM kristine.goods_receipt_lines WHERE receipt_id=NEW.id GROUP BY product_id) r
        FULL JOIN (SELECT product_id,sum(quantity*stock_units_per_purchase_unit) AS quantity FROM kristine.purchase_order_lines WHERE purchase_order_id=NEW.purchase_order_id GROUP BY product_id) o USING(product_id)
        WHERE r.quantity IS DISTINCT FROM o.quantity
      ) THEN RAISE EXCEPTION 'Receipt and purchase order quantities differ'; END IF;
    END IF;
    NEW.revision:=OLD.revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.goods_receipts FOR EACH ROW EXECUTE FUNCTION kristine.guard_receipt();
CREATE FUNCTION kristine.post_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
BEGIN
  IF OLD.status='pending' AND NEW.status='confirmed' THEN
    INSERT INTO kristine.stock_movements(company_id,warehouse_id,product_id,stock_unit,delta,reason,idempotency_key,receipt_line_id)
    SELECT NEW.company_id,NEW.warehouse_id,l.product_id,l.stock_unit,l.stock_quantity,'goods_received','receipt:'||l.id::text,l.id FROM kristine.goods_receipt_lines l WHERE l.receipt_id=NEW.id;
    IF NEW.purchase_order_id IS NOT NULL THEN UPDATE kristine.purchase_orders SET status='received' WHERE id=NEW.purchase_order_id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_post AFTER UPDATE ON kristine.goods_receipts FOR EACH ROW EXECUTE FUNCTION kristine.post_receipt();
CREATE FUNCTION kristine.guard_purchase_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,kristine AS $$
DECLARE po kristine.purchase_orders%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.company_id,NEW.purchase_order_id) IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.purchase_order_id) THEN RAISE EXCEPTION 'Purchase line identity is immutable'; END IF;
  IF TG_OP='DELETE' THEN SELECT * INTO STRICT po FROM kristine.purchase_orders WHERE id=OLD.purchase_order_id FOR UPDATE;
  ELSE SELECT * INTO STRICT po FROM kristine.purchase_orders WHERE id=NEW.purchase_order_id FOR UPDATE; END IF;
  IF po.status IN ('received','cancelled','archived') THEN RAISE EXCEPTION 'Closed purchase order lines are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_line_guard BEFORE INSERT OR UPDATE OR DELETE ON kristine.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION kristine.guard_purchase_line();
CREATE VIEW kristine.stock_balances AS SELECT company_id,warehouse_id,product_id,stock_unit,sum(delta) AS quantity FROM kristine.stock_movements GROUP BY company_id,warehouse_id,product_id,stock_unit;

CREATE TRIGGER price_history_immutable BEFORE UPDATE OR DELETE ON kristine.price_history FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER bank_transaction_immutable BEFORE UPDATE OR DELETE ON kristine.bank_transactions FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON kristine.stock_movements FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER allocation_event_immutable BEFORE UPDATE OR DELETE ON kristine.payment_allocation_events FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER stock_movement_no_truncate BEFORE TRUNCATE ON kristine.stock_movements FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER bank_transaction_no_truncate BEFORE TRUNCATE ON kristine.bank_transactions FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER allocation_event_no_truncate BEFORE TRUNCATE ON kristine.payment_allocation_events FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER allocation_no_truncate BEFORE TRUNCATE ON kristine.payment_allocations FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER payment_no_truncate BEFORE TRUNCATE ON kristine.payments FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER price_history_no_truncate BEFORE TRUNCATE ON kristine.price_history FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE INDEX incoming_invoice_supplier_date ON kristine.incoming_invoices(company_id,supplier_id,issued_on);
CREATE INDEX outgoing_invoice_project_date ON kristine.outgoing_invoices(company_id,project_id,issued_on);
CREATE INDEX allocation_incoming ON kristine.payment_allocations(incoming_invoice_id);
CREATE INDEX allocation_outgoing ON kristine.payment_allocations(outgoing_invoice_id);
CREATE INDEX stock_movements_product ON kristine.stock_movements(company_id,warehouse_id,product_id);
COMMIT;

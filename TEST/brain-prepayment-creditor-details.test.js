const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const loader = read('brain_incoming_op.py');
const prepayment = read('brain_capture_prepayment.py');
const source = read('brain_finance_source.py');
const runtime = read('brain_finance_runtime.py');
const ui = read('brain_finance_creditor_ui.py');
const service = read('brain_service_runtime.py');
const connector = read('archive-connector.py');
const intake = read('brain_invoice_intake.py');
const intakeStore = read('kristine-invoice-intake.js');

assert(loader.includes('from brain_capture_prepayment import install as _capture_prepayment_install'));
assert(loader.indexOf('_capture_prepayment_install(ns)') > loader.indexOf('_capture_duplicate_guard_install(ns)'));
assert(loader.includes('_creditor_ui_install(ns)'));

assert(prepayment.includes('PREPAYMENT_TYPE = "Vorkassarechnung"'));
assert(prepayment.includes('CREATE TABLE IF NOT EXISTS incoming_invoice_history'));
assert(prepayment.includes('"prepayment_replaced"'));
assert(prepayment.includes('replacedPrepayment'));
assert(prepayment.includes('filesPreserved=True'));
assert(prepayment.includes('Bezahlte oder bereits an SEPA übergebene Rechnungen dürfen nicht gelöscht werden.'));
assert(prepayment.includes('/incoming/capture/prepayments'));
assert(intake.includes('/incoming/intake-delete'));
assert(intake.includes('data-intake-delete'));
assert(intakeStore.includes('app.delete("/kristine/api/invoice-intake/:id"'));
assert(intakeStore.includes('filesPreserved: true'));
assert(intakeStore.includes('["processed", "deleted"]'));

assert(source.includes('CREATE TABLE IF NOT EXISTS brain_creditor_details'));
assert(source.includes('def set_creditor_details('));
assert(source.includes('row["invoiceAmount"]'));
assert(runtime.includes('/incoming/creditor-details'));
assert(runtime.includes('payment=approved+fees if decision in FINAL_APPROVALS else 0.0'));
assert(runtime.includes('+ Mahnspesen'));
assert(runtime.includes('in {"paid","sepa_submitted"}'));

assert(ui.includes('Kreditoren-OP: anklickbar'));
assert(ui.includes('Mahnstufe'));
assert(ui.includes('Mahnspesen €'));
assert(ui.includes("fetch('/incoming/creditor-details'"));
assert(ui.includes("event.target.closest('input,a,button,select')"));

assert(service.includes('BRAIN_CONNECTOR_VERSION = "0.14.66"'));
assert(connector.includes('"version": "0.14.66"'));

console.log('prepayment and creditor details checks: ok');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const source = read('brain_finance_source.py');
const currency = read('brain_currency_payment_v2.py');
const bridge = read('brain_finance_reconciliation_bridge.py');
const page = read('brain_revolut_business.py');
const intake = read('brain_invoice_intake.py');
const loader = read('brain_incoming_op.py');
const connection = read('brain_revolut_connection.py');
const runtime = read('brain_service_runtime.py');
const home = read('brain_home_nav.py');

assert(source.includes('"revolut_business"'));
assert(currency.includes('<option value="revolut_business">Revolut Business</option>'));
assert(bridge.includes('statement_source = "REVOLUT_BUSINESS"'));
assert(bridge.includes('/kristine/api/invoice-intake/import'));
assert(bridge.includes('"paymentContext": payment_context'));
assert(bridge.includes('autoPaid=0'));
assert(!bridge.includes('store.set_meta(target_source, target_id, status="paid")'));

assert(page.includes('/incoming/revolut/candidates'));
assert(page.includes('/incoming/revolut/sync'));
assert(page.includes('Live aktualisieren'));
assert(page.includes('data-move='));
assert(page.includes('Buchung ohne Beleg erfassen'));
assert(page.includes("post('supplier_payment'"));
assert(page.includes('Spesen / Bankgebühr'));
assert(page.includes('Privat'));
assert(page.includes('Rest 0,00'));

assert(intake.includes('data-context='));
assert(intake.includes("ctx.includes('business')?'revolut_business'"));
assert(loader.includes('_revolut_business_install(ns)'));
assert(connection.includes('API = "https://b2b.revolut.com/api/1.0"'));
assert(read('brain_konfipay.py').includes('KonfipayError = ConnectionError'));
assert(connection.includes('endpoint not in {"/accounts", "/transactions", "/expenses"}'));
assert(connection.includes('def receipt(self, expense_id, receipt_id):'));
assert(home.includes("bank.textContent='🏦 Bank'"));
assert(home.includes("window.location.href='/konfipay'"));
assert(home.includes('Revolut Business'));
assert(home.includes("window.location.href='/incoming/revolut'"));
assert(runtime.includes('BRAIN_CONNECTOR_VERSION = "0.14.79"'));

const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.strictEqual(scripts.length, 1, 'Revolut Business page script missing');
new Function(scripts[0][1]);

console.log('Revolut Business flow: ok');

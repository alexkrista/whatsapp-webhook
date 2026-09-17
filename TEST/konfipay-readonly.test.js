"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const backend = fs.readFileSync(path.join(root, "brain_konfipay.py"), "utf8");
const page = fs.readFileSync(path.join(root, "public", "konfipay.html"), "utf8");
const home = fs.readFileSync(path.join(root, "brain_home_nav.py"), "utf8");

assert.match(backend, /ENABLED_ENV\s*=\s*"KRISTA_KONFIPAY_ENABLED"/);
assert.match(backend, /os\.environ\.get\(ENABLED_ENV,\s*""\)/, "feature flag must default to off");
assert.match(backend, /if not feature_enabled\(\):[\s\S]{0,160}return False/);

for (const route of ["status", "connect", "refresh", "transactions", "statements", "statement-download"]) {
  assert(backend.includes(`/konfipay/api/${route}`), `missing read-only route ${route}`);
}
assert.strictEqual((backend.match(/@app\.post\(/g) || []).length, 1, "only local key setup may be a POST route");
assert.match(backend, /@app\.post\("\/konfipay\/api\/connect"/);
assert.match(backend, /request\.remote_addr in \{"127\.0\.0\.1", "::1"\}/);
assert.match(backend, /X-Brain-Konfipay/);
assert.match(backend, /class NoRedirect/);
assert.match(backend, /Content-Disposition[^\n]+attachment/);
assert.match(backend, /X-Content-Type-Options/);
assert.match(backend, /accounts\s*=\s*self\.accounts\(token\)[\s\S]{0,180}self\.store\.save\(key\)/, "key is saved only after a successful read-only account check");

for (const forbidden of [
  "/payment-files", "/payments", "payment-submit", "payment-prepare",
  "assignment-save", "assignment-decide", "assignments.observe",
  "brain_bank_assignment", "brain_finance_direct_pay", "threading.Thread", "sqlite3",
]) {
  assert(!backend.includes(forbidden), `forbidden write integration found in backend: ${forbidden}`);
  assert(!page.includes(forbidden), `forbidden write integration found in page: ${forbidden}`);
}

assert.match(page, /Nur lesen/);
assert.match(page, /keine Zahlung, Bankzuordnung oder Gutschrift auslösen/);
assert.strictEqual((page.match(/method:\s*"POST"/g) || []).length, 1, "page may POST only the local API key setup");
assert(!page.includes("innerHTML"), "bank-provided values must be rendered through textContent/DOM nodes");
for (const dependency of ["revolut", "kassa", "controlling", "directPay"]) {
  assert(!page.toLowerCase().includes(dependency.toLowerCase()), `unwanted page dependency: ${dependency}`);
}

assert.match(home, /konfipay_enabled\s*=\s*brain_konfipay\.install\(ns\)/);
assert.match(home, /if konfipay_enabled else ''/);
assert.match(home, /Konten · nur lesen/);
assert.match(home, /script = script\.replace\("__KONFIPAY_NAV__", bank_nav\)/);

console.log("OK: Konfipay K1 bleibt standardmäßig aus und enthält nur Lesefunktionen plus lokale Schlüssel-Einrichtung.");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const backend = fs.readFileSync(path.join(root, "brain_konfipay.py"), "utf8");
const page = fs.readFileSync(path.join(root, "public", "konfipay.html"), "utf8");
const home = fs.readFileSync(path.join(root, "brain_home_nav.py"), "utf8");

assert.match(backend, /brain_konfipay_banking\.install\(ns, client, write_allowed, csrf\)/);
assert.match(backend, /\/payment-files/);
assert.match(backend, /\/payments/);
assert.match(backend, /X-Brain-Konfipay/);
assert.match(backend, /class NoRedirect/);

for (const label of [
  "Kontostände", "Erwarteter Kontostand", "Gebuchte Umsätze",
  "Untertägige Umsätze", "Kontoauszüge", "Zahlungsarchiv", "Zahlung zuordnen",
]) assert(page.includes(label), `vollständiger Bankbereich fehlt: ${label}`);

assert.match(home, /brain_konfipay\.install\(ns\)/);
assert.match(home, /bank\.textContent='🏦 Bank'/);
assert.match(home, /window\.location\.href='\/konfipay'/);
assert.match(home, /revolut\.textContent='💳 Revolut Business'/);
assert.match(home, /window\.location\.href='\/incoming\/revolut'/);

console.log("OK: Vollständiger Bankbereich und Revolut sind getrennt erreichbar.");

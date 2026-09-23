const assert = require('assert');
const fs = require('fs');

const page = fs.readFileSync('public/konfipay.html', 'utf8');
const revolut = fs.readFileSync('brain_revolut_connection.py', 'utf8');

assert(page.includes("title.textContent='Gesamter Cash'"));
assert(page.includes("line('Bankkonten · erwartet'"));
assert(page.includes("line('Revolut Business'"));
assert(page.includes("line('Revolut'"));
assert(page.includes("line('Kassastand'"));
assert(page.includes("line('Gesamt-Cash'"));
assert(page.includes("await renderLiquidity(data)"));
assert(page.includes('Promise.allSettled'));
assert(page.includes("line('Bekannter Cash · unvollständig'"));
assert(page.includes("timed('/incoming/revolut-personal/status',25000)"));
assert(page.includes("Revolut · Belege zuordnen"));
assert(page.includes("Revolut Business · Belege zuordnen"));
assert(page.includes('revolut-transfer-prepare'));
assert(revolut.includes('@app.get("/revolut/balances")'));
assert(revolut.includes('totals={key: format(value, ".2f")'));
assert(revolut.includes('stale=True'));

console.log('OK: Gesamter Cash enthält Bank, Revolut, Revolut Business und Kassa.');

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
assert(revolut.includes('@app.get("/revolut/balances")'));
assert(revolut.includes('totals={key: format(value, "f")'));

console.log('OK: Gesamter Cash enthält Bank, Revolut, Revolut Business und Kassa.');

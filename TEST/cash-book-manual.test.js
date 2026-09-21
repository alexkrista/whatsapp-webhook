const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const ui=fs.readFileSync(path.join(root,'public','cash-book.js'),'utf8');
const api=fs.readFileSync(path.join(root,'brain_cash_book.py'),'utf8');
for(const text of ['+ Kassaeingang buchen','Kassaeingang verbindlich buchen','manual-incoming','Einnahmenbeleg'])assert.ok(ui.includes(text),text);
for(const text of ["def manual_incoming", "direction='Eingang'", "@app.post(PREFIX+'/manual-incoming')"])assert.ok(api.includes(text),text);
console.log('manual cash incoming checks: ok');

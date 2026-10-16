const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'../public/invoice-book.html'),'utf8');
const context=vm.createContext({});vm.runInContext(html.split('// BEGIN invoice book filters')[1].split('// END invoice book filters')[0],context);
test('bank includes SEPA and debit; month and inclusive date range combine',()=>{
const rows=[{invoiceDate:'2026-08-01',paymentMethod:'transfer'},{invoiceDate:'2026-08-31',paymentMethod:'direct_debit'},{invoiceDate:'2026-09-01',paymentMethod:'transfer'},{invoiceDate:'2026-08-20',paymentMethod:'cash'}];
assert.equal(context.filterBookRows(rows,{month:'08',paymentChannel:'bank'}).length,2);
assert.equal(context.filterBookRows(rows,{month:'08',from:'2026-08-31',to:'2026-08-31',paymentChannel:'bank'}).length,1);
});
test('filtered monthly totals retain partial balances and separate currencies',()=>{
const m=context.filteredBookMonths([{invoiceDate:'2026-08-01',amount:100,bookOpenAmount:40,currency:'EUR'},{invoiceDate:'2026-08-01',amount:20,bookOpenAmount:0,currency:'CHF'}]);
assert.equal(m.length,2);const e=m.find(x=>x.currency==='EUR');assert.equal(e.paid,60);assert.equal(e.open,40);
});
test('invoice book scripts parse',()=>{for(const file of ['invoice-book.html','outgoing-invoice-book.html'])new vm.Script(fs.readFileSync(path.join(__dirname,'../public',file),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1])});

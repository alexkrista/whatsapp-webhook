const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/invoice-book.html'),'utf8');
const code=html.split('// BEGIN operational invoice balances')[1].split('// END operational invoice balances')[0];
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const context=vm.createContext({});vm.runInContext(code,context);
const run=(rows,p)=>context.reconcileBookBalances(rows,{ok:true,items:[],submitted:[],directDebit:[],...p});
const row=(id,amount=100)=>({source:'KRISTINE',id,amount,paymentStatus:'open',invoiceDate:'2026-09-01'});
test('only creditors, pending handoffs and expected debits count, not unknown payment methods',()=>{
 const rows=[row('transfer'),row('debit'),row('submitted'),row('unknown'),row('absent')];
 const result=run(rows,{items:[rows[0]],directDebit:[rows[1]],submitted:[rows[2]],unclassified:[rows[3]]});
 assert.equal(result.months[0].open,300);assert.equal(result.months[0].notOpen,200);
 assert.equal(result.items[3].bookStatus,'not_open');assert.equal(result.items[4].bookStatus,'not_open');
 assert.equal(rows[4].paymentStatus,'open');
});
test('partial payment counts remaining amount, preserves historical amount and paid amount',()=>{
 const invoice={...row('partial'),bankPaid:60};const result=run([invoice],{items:[{...invoice,amount:40}]});
 assert.equal(result.months[0].open,40);assert.equal(result.months[0].paid,60);assert.equal(result.months[0].notOpen,0);assert.equal(result.items[0].amount,100);
});
test('duplicate operational rows count once; distinct sources do not collide; query limits do not inflate totals',()=>{
 const x=row('1');const result=run([x],{items:[{...x,source:'WinWorker'},row('other')],directDebit:[x,x]});assert.equal(result.months[0].open,100);
});
test('paid invoices and zero residuals are not open',()=>{
 const x={...row('paid'),paymentStatus:'paid'};const result=run([x,row('zero')],{items:[x,{...row('zero'),amount:0}]});
 assert.equal(result.months[0].open,0);assert.equal(result.months[0].paid,100);assert.equal(result.items[1].bookOpen,false);
});
test('failed or incomplete operational response cannot silently close everything',()=>{
 assert.throws(()=>run([row('a')],{ok:false}));assert.throws(()=>run([row('a')],{directDebit:undefined}));
});

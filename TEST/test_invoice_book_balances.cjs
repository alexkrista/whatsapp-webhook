const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/invoice-book.html'),'utf8');
const code=html.split('// BEGIN operational invoice balances')[1].split('// END operational invoice balances')[0];
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const context=vm.createContext({});vm.runInContext(code,context);
const run=(rows,p)=>context.reconcileBookBalances(rows,{ok:true,items:[],submitted:[],directDebit:[],...p});
const row=(id,amount=100)=>({source:'WinWorker',id,amount,paymentStatus:'open',invoiceDate:'2026-09-01'});
test('only creditors, pending handoffs and expected debits count, not unknown payment methods',()=>{
 const rows=[row('transfer'),row('debit'),row('submitted'),row('unknown'),row('absent')];
 const result=run(rows,{items:[rows[0]],directDebit:[rows[1]],submitted:[rows[2]],unclassified:[rows[3]]});
 assert.equal(result.months[0].open,300);assert.equal(result.months[0].paid,200);
 assert.equal(result.items[3].bookStatus,'paid');assert.equal(result.items[4].bookStatus,'paid');
 assert.equal(rows[4].paymentStatus,'open');
});
test('partial payment counts remaining amount, preserves historical amount and paid amount',()=>{
 const invoice={...row('partial'),bankPaid:60};const result=run([invoice],{items:[{...invoice,amount:40}]});
 assert.equal(result.months[0].open,40);assert.equal(result.months[0].paid,60);assert.equal(result.items[0].amount,100);
});
test('duplicate operational rows count once; distinct sources do not collide; query limits do not inflate totals',()=>{
 const x=row('1');const result=run([x],{items:[{...x,source:'KRISTINE'},row('other')],directDebit:[x,x]});assert.equal(result.months[0].open,100);
});
test('paid invoices and zero residuals are not open',()=>{
 const x={...row('paid'),paymentStatus:'paid'};const result=run([x,row('zero')],{items:[x,{...row('zero'),amount:0}]});
 assert.equal(result.months[0].open,0);assert.equal(result.months[0].paid,200);assert.equal(result.items[1].bookOpen,false);
});
test('failed or incomplete operational response cannot silently close everything',()=>{
 assert.throws(()=>run([row('a')],{ok:false}));assert.throws(()=>run([row('a')],{directDebit:undefined}));
});

test('KRISTINE prepayments remain open despite missing approval in payment selection',()=>{
 const invoice={...row('kristine:37',190.17),source:'KRISTINE'};
 const r=run([invoice],{});assert.equal(r.items[0].bookStatus,'open');assert.equal(r.months[0].open,190.17);assert.equal(r.months[0].paid,0);
});
test('new WinWorker invoices and undated invoices retain their status',()=>{
 const r=run([{...row('new'),invoiceDate:'2026-09-26'},{...row('undated'),invoiceDate:''}],{});
 assert.ok(r.items.every(x=>x.bookStatus==='open'));assert.equal(r.months.reduce((a,m)=>a+m.open,0),200);
});
test('KRISTINE bank residual is preserved',()=>{
 const r=run([{...row('local'),source:'KRISTINE',bankPaid:60,openAmount:40}],{});
 assert.equal(r.months[0].open,40);assert.equal(r.months[0].paid,60);
});

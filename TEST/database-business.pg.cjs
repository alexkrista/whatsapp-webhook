'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
test('PostgreSQL business schema and financial/stock integrity',async t=>{
  const db=new PGlite(); const q=(sql,args)=>db.query(sql,args);
  async function reject(sql,args=[],pattern){
    await q('SAVEPOINT expected_failure');let error;
    try{await q(sql,args);}catch(e){error=e;}
    await q('ROLLBACK TO SAVEPOINT expected_failure');await q('RELEASE SAVEPOINT expected_failure');
    assert.ok(error,'Expected database rejection');if(pattern)assert.match(error.message,pattern);
  }
  const isolated=(name,fn)=>t.test(name,async()=>{await q('BEGIN');try{await fn();}finally{await q('ROLLBACK');}});
  try{
    for(const file of ['002-domain-core.sql','003-business-domain.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    const a=(await q("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
    const b=(await q("INSERT INTO kristine.companies(name) VALUES('B') RETURNING id")).rows[0].id;
    const supplier=(await q("INSERT INTO kristine.parties(company_id,kind,display_name) VALUES($1,'organization','Supplier') RETURNING id",[a])).rows[0].id;
    const project=(await q("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,'26001','Test',2) RETURNING id",[a])).rows[0].id;
    await q("INSERT INTO kristine.units VALUES('L','Liter'),('box','Box')");
    const product=(await q("INSERT INTO kristine.products(company_id,sku,name,stock_unit) VALUES($1,'001','Paint','L') RETURNING id",[a])).rows[0].id;
    const warehouse=(await q("INSERT INTO kristine.warehouses(company_id,name) VALUES($1,'Main') RETURNING id",[a])).rows[0].id;
    const account=(await q("INSERT INTO kristine.financial_accounts(company_id,name,kind,currency) VALUES($1,'Test','bank','EUR') RETURNING id",[a])).rows[0].id;
    const source=(await q("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test-bank') RETURNING id",[a])).rows[0].id;
    let sequence=0;
    const invoice=async(currency='EUR',kind='invoice')=>(await q("INSERT INTO kristine.incoming_invoices(company_id,supplier_id,project_id,invoice_number,issued_on,kind,document_status,payment_method,currency,net_amount,tax_amount,gross_amount) VALUES($1,$2,$3,$4,'2026-10-06',$5,'issued','transfer',$6,100,20,120) RETURNING id",[a,supplier,project,'INV-'+(++sequence),kind,currency])).rows[0].id;
    const payment=async(amount='100',currency='EUR',acc=account,direction='outgoing')=>(await q("INSERT INTO kristine.payments(company_id,account_id,direction,method,status,amount,currency) VALUES($1,$2,$3,'transfer','planned',$4,$5) RETURNING id",[a,acc,direction,amount,currency])).rows[0].id;
    const transaction=async(amount='-100',currency='EUR',acc=account,original=null,originalCurrency=null)=>{
      const ext='TX-'+(++sequence);
      const sr=(await q("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'bank_transaction',$3) RETURNING id",[a,source,ext])).rows[0].id;
      return(await q("INSERT INTO kristine.bank_transactions(company_id,account_id,external_id,booked_on,amount,currency,original_amount,original_currency,source_record_id) VALUES($1,$2,$3,'2026-10-06',$4,$5,$6,$7,$8) RETURNING id",[a,acc,ext,amount,currency,original,originalCurrency,sr])).rows[0].id;
    };
    const allocation=(p,i,amount='100',discount='0')=>q('INSERT INTO kristine.payment_allocations(company_id,payment_id,incoming_invoice_id,allocated_amount,discount_amount) VALUES($1,$2,$3,$4,$5)',[a,p,i,amount,discount]);
    const receipt=async(i=null,po=null)=>(await q("INSERT INTO kristine.goods_receipts(company_id,warehouse_id,incoming_invoice_id,purchase_order_id,received_on) VALUES($1,$2,$3,$4,'2026-10-06') RETURNING id",[a,warehouse,i,po])).rows[0].id;
    const receiptLine=async(r,qty='10')=>(await q("INSERT INTO kristine.goods_receipt_lines(company_id,receipt_id,product_id,position_number,stock_quantity,stock_unit) VALUES($1,$2,$3,'01',$4,'L') RETURNING id",[a,r,product,qty])).rows[0].id;
    const confirm=r=>q("UPDATE kristine.goods_receipts SET status='confirmed',confirmed_at=clock_timestamp(),confirmed_by='test' WHERE id=$1",[r]);

    await isolated('64 normalized tables and exact decimal money',async()=>{
      assert.equal((await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='kristine' AND table_type='BASE TABLE'")).rows[0].n,64);
      assert.equal((await q("SELECT (0.1::numeric+0.2::numeric)::text AS amount")).rows[0].amount,'0.3');
      await reject("INSERT INTO kristine.incoming_invoices(company_id,supplier_id,invoice_number,issued_on,kind,document_status,payment_method,currency,net_amount,tax_amount,gross_amount) VALUES($1,$2,'bad','2026-10-06','invoice','issued','transfer','EUR',100,20,121)",[a,supplier]);
    });
    await isolated('SEPA submission is not payment; bank reconciliation plus discount settles invoice',async()=>{
      const i=await invoice(),p=await payment();await allocation(p,i,'100','20');
      assert.equal((await q('SELECT settlement_status FROM kristine.incoming_invoice_settlement WHERE id=$1',[i])).rows[0].settlement_status,'open');
      await q("UPDATE kristine.payments SET status='submitted' WHERE id=$1",[p]);
      assert.equal((await q('SELECT settlement_status FROM kristine.incoming_invoice_settlement WHERE id=$1',[i])).rows[0].settlement_status,'sepa_handed');
      await reject("UPDATE kristine.payments SET status='settled' WHERE id=$1",[p]);
      const bank=await transaction();await q("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,p]);
      const state=(await q('SELECT settlement_status,outstanding_gross::text FROM kristine.incoming_invoice_settlement WHERE id=$1',[i])).rows[0];
      assert.deepEqual(state,{settlement_status:'paid',outstanding_gross:'0.0000'});
    });
    await isolated('partial payment remains open and cannot exceed payment or invoice amount',async()=>{
      const i=await invoice(),p=await payment();await allocation(p,i,'50');
      const bank=await transaction();await q("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,p]);
      assert.equal((await q('SELECT outstanding_gross::text FROM kristine.incoming_invoice_settlement WHERE id=$1',[i])).rows[0].outstanding_gross,'70.0000');
      const another=await payment('100');await reject('INSERT INTO kristine.payment_allocations(company_id,payment_id,incoming_invoice_id,allocated_amount) VALUES($1,$2,$3,80)',[a,another,i],/over-allocation/);
      const otherInvoice=await invoice();await reject('INSERT INTO kristine.payment_allocations(company_id,payment_id,incoming_invoice_id,allocated_amount) VALUES($1,$2,$3,101)',[a,another,otherInvoice],/Payment over-allocation/);
    });
    await isolated('currency, direction and bank amounts must match',async()=>{
      const i=await invoice('CHF'),p=await payment();await reject('INSERT INTO kristine.payment_allocations(company_id,payment_id,incoming_invoice_id,allocated_amount) VALUES($1,$2,$3,100)',[a,p,i],/currency/);
      const bank=await transaction('-99');await reject("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,p],/does not match/);
      const incomingBank=await transaction('100');await reject("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[incomingBank,p],/does not match/);
    });
    await isolated('foreign currency settlement retains both original and account amounts',async()=>{
      const acc=(await q("INSERT INTO kristine.financial_accounts(company_id,name,kind,currency) VALUES($1,'CHF','revolut','CHF') RETURNING id",[a])).rows[0].id;
      const p=await payment('100','EUR',acc),bank=await transaction('-95','CHF',acc,'-100','EUR');
      await q("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,p]);
      assert.equal((await q('SELECT amount::text FROM kristine.payments WHERE id=$1',[p])).rows[0].amount,'100.0000');
    });
    await isolated('bank evidence and settled payments cannot be reused or rewritten',async()=>{
      const bank=await transaction(),p=await payment();await q("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,p]);
      const other=await payment();await reject("UPDATE kristine.payments SET status='settled',bank_transaction_id=$1 WHERE id=$2",[bank,other]);
      await reject('UPDATE kristine.bank_transactions SET amount=-1 WHERE id=$1',[bank],/append-only/);
      await reject("UPDATE kristine.payments SET status='planned' WHERE id=$1",[p],/immutable/);
    });
    await isolated('cancelled allocations cannot be reactivated into an overpaid invoice',async()=>{
      const i=await invoice(),p=await payment();await allocation(p,i);await q("UPDATE kristine.payments SET status='cancelled' WHERE id=$1",[p]);
      const other=await payment('120');await allocation(other,i,'120');
      await reject("UPDATE kristine.payments SET status='planned' WHERE id=$1",[p],/reactivating/);
      await reject('UPDATE kristine.incoming_invoices SET gross_amount=121,tax_amount=21 WHERE id=$1',[i],/immutable/);
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.payment_allocation_events')).rows[0].n,2);
    });
    await isolated('credit notes require reversed payment direction',async()=>{
      const i=await invoice('EUR','credit_note'),p=await payment();
      await reject('INSERT INTO kristine.payment_allocations(company_id,payment_id,incoming_invoice_id,allocated_amount) VALUES($1,$2,$3,100)',[a,p,i],/direction/);
      await allocation(await payment('100','EUR',account,'incoming'),i);
    });
    await isolated('financial foreign keys and external source mappings stay company-scoped',async()=>{
      const foreign=(await q("INSERT INTO kristine.products(company_id,sku,name,stock_unit) VALUES($1,'001','Other','L') RETURNING id",[b])).rows[0].id;
      await reject('INSERT INTO kristine.supplier_products(company_id,supplier_id,product_id,supplier_sku,purchase_unit,stock_units_per_purchase_unit) VALUES($1,$2,$3,\'x\',\'box\',10)',[a,supplier,foreign]);
      const sr=(await q("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'invoice','001') RETURNING id",[a,source])).rows[0].id;
      const i=await invoice();await q('INSERT INTO kristine.external_references(company_id,source_record_id,incoming_invoice_id) VALUES($1,$2,$3)',[a,sr,i]);
      await reject('UPDATE kristine.external_references SET product_id=$1 WHERE source_record_id=$2',[product,sr]);
    });
    await isolated('invoice capture and pending receipt do not increase stock',async()=>{
      const i=await invoice(),r=await receipt(i),line=await receiptLine(r);
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.stock_movements')).rows[0].n,0);
      await reject("INSERT INTO kristine.stock_movements(company_id,warehouse_id,product_id,stock_unit,delta,reason,idempotency_key,receipt_line_id) VALUES($1,$2,$3,'L',10,'goods_received','bad',$4)",[a,warehouse,product,line],/not confirmed/);
    });
    await isolated('receipt confirmation posts stock atomically and a no-op retry does not duplicate',async()=>{
      const r=await receipt(await invoice());await receiptLine(r);await confirm(r);
      await q('UPDATE kristine.goods_receipts SET status=status WHERE id=$1',[r]);
      assert.equal((await q('SELECT quantity::text FROM kristine.stock_balances WHERE product_id=$1',[product])).rows[0].quantity,'10.000000');
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.stock_movements')).rows[0].n,1);
      await reject('UPDATE kristine.goods_receipt_lines SET stock_quantity=11 WHERE receipt_id=$1',[r],/immutable/);
      await reject('DELETE FROM kristine.stock_movements',[],/append-only/);
      await reject('TRUNCATE kristine.stock_movements',[],/append-only/);
    });
    await isolated('empty receipts and incorrect stock units fail',async()=>{
      const r=await receipt();await reject("UPDATE kristine.goods_receipts SET status='confirmed',confirmed_at=clock_timestamp(),confirmed_by='test' WHERE id=$1",[r],/Empty receipt/);
      await reject("INSERT INTO kristine.goods_receipt_lines(company_id,receipt_id,product_id,position_number,stock_quantity,stock_unit) VALUES($1,$2,$3,'01',1,'box')",[a,r,product],/unit mismatch/);
    });
    await isolated('linked purchase order quantities must match before confirmation',async()=>{
      const po=(await q("INSERT INTO kristine.purchase_orders(company_id,supplier_id,order_number,ordered_on,status,currency) VALUES($1,$2,'PO-001','2026-10-06','sent','EUR') RETURNING id",[a,supplier])).rows[0].id;
      await q("INSERT INTO kristine.purchase_order_lines(company_id,purchase_order_id,product_id,position_number,quantity,purchase_unit,stock_units_per_purchase_unit,net_unit_price) VALUES($1,$2,$3,'01',1,'box',10,100)",[a,po,product]);
      const r=await receipt(null,po),line=await receiptLine(r,'9');
      await reject("UPDATE kristine.goods_receipts SET status='confirmed',confirmed_at=clock_timestamp(),confirmed_by='test' WHERE id=$1",[r],/quantities differ/);
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.stock_movements')).rows[0].n,0);
      await q('UPDATE kristine.goods_receipt_lines SET stock_quantity=10 WHERE id=$1',[line]);await confirm(r);
      assert.equal((await q('SELECT status FROM kristine.purchase_orders WHERE id=$1',[po])).rows[0].status,'received');
      await reject('UPDATE kristine.purchase_order_lines SET quantity=2 WHERE purchase_order_id=$1',[po],/immutable/);
    });
    await isolated('stock consumption is signed and movement keys prevent repeats',async()=>{
      await q("INSERT INTO kristine.stock_movements(company_id,warehouse_id,product_id,stock_unit,delta,reason,idempotency_key) VALUES($1,$2,$3,'L',10,'opening','opening-001')",[a,warehouse,product]);
      await q("INSERT INTO kristine.stock_movements(company_id,warehouse_id,product_id,stock_unit,delta,reason,idempotency_key,project_id) VALUES($1,$2,$3,'L',-2,'consumption','use-001',$4)",[a,warehouse,product,project]);
      assert.equal((await q('SELECT quantity::text FROM kristine.stock_balances')).rows[0].quantity,'8.000000');
      await reject("INSERT INTO kristine.stock_movements(company_id,warehouse_id,product_id,stock_unit,delta,reason,idempotency_key) VALUES($1,$2,$3,'L',10,'opening','opening-001')",[a,warehouse,product]);
    });
    await isolated('regie retains employee and material snapshots with exact totals',async()=>{
      const r=(await q("INSERT INTO kristine.regie_reports(company_id,project_id,report_number,work_date,description,status,currency,labor_net,material_net,tax_amount,gross_amount) VALUES($1,$2,'001','2026-10-06','Work','draft','EUR',200,100,60,360) RETURNING id",[a,project])).rows[0].id;
      await q("INSERT INTO kristine.regie_people(company_id,report_id,employee_name_snapshot,hours,hourly_rate,labor_net) VALUES($1,$2,'Historical person',2,100,200)",[a,r]);
      await q("INSERT INTO kristine.regie_material_lines(company_id,report_id,product_id,description_snapshot,quantity,unit,net_unit_price,net_amount) VALUES($1,$2,$3,'Paint snapshot',10,'L',10,100)",[a,r,product]);
      await reject('UPDATE kristine.regie_reports SET gross_amount=361 WHERE id=$1',[r]);
    });
    await isolated('offer versions and accepted order lines preserve numbers, discounts and payment terms',async()=>{
      const offer=(await q("INSERT INTO kristine.offers(company_id,project_id,customer_id,offer_number,version,status,currency,price_mode,discount_percent,net_amount,tax_amount,gross_amount,payment_terms_snapshot) VALUES($1,$2,$3,'001',1,'accepted','EUR','gross',2,100,20,120,'{\"skontoPercent\":2}') RETURNING id",[a,project,supplier])).rows[0].id;
      await q("INSERT INTO kristine.offer_lines(company_id,offer_id,position_number,description,quantity,unit,entered_unit_price,net_unit_price,net_amount,tax_rate,alternative_group,selected) VALUES($1,$2,'01.001','Work',2,'L',60,50,100,20,'option-a',true)",[a,offer]);
      const order=(await q("INSERT INTO kristine.orders(company_id,project_id,customer_id,source_offer_id,order_number,ordered_on,status,currency,net_amount,tax_amount,gross_amount) VALUES($1,$2,$3,$4,'001','2026-10-06','confirmed','EUR',100,20,120) RETURNING id",[a,project,supplier,offer])).rows[0].id;
      await q("INSERT INTO kristine.order_lines(company_id,order_id,position_number,description,quantity,unit,net_unit_price,net_amount,tax_rate) SELECT company_id,$1,position_number,description,quantity,unit,net_unit_price,net_amount,tax_rate FROM kristine.offer_lines WHERE offer_id=$2",[order,offer]);
      assert.equal((await q('SELECT position_number FROM kristine.order_lines WHERE order_id=$1',[order])).rows[0].position_number,'01.001');
      assert.deepEqual((await q('SELECT payment_terms_snapshot FROM kristine.offers WHERE id=$1',[offer])).rows[0].payment_terms_snapshot,{skontoPercent:2});
      await reject("INSERT INTO kristine.offers(company_id,project_id,customer_id,offer_number,version,status,currency,price_mode,net_amount,tax_amount,gross_amount) VALUES($1,$2,$3,'001',1,'draft','EUR','net',100,20,120)",[a,project,supplier]);
    });
    await isolated('supplier price changes retain history instead of overwriting it',async()=>{
      const sp=(await q("INSERT INTO kristine.supplier_products(company_id,supplier_id,product_id,supplier_sku,purchase_unit,stock_units_per_purchase_unit) VALUES($1,$2,$3,'001','box',10) RETURNING id",[a,supplier,product])).rows[0].id;
      await q("INSERT INTO kristine.price_history(company_id,supplier_product_id,effective_on,unit_price,price_per_quantity,currency) VALUES($1,$2,'2025-01-01',100,1,'EUR'),($1,$2,'2026-01-01',110,1,'EUR')",[a,sp]);
      assert.equal((await q('SELECT count(*)::int AS n FROM kristine.price_history')).rows[0].n,2);
      await reject('UPDATE kristine.price_history SET unit_price=1',[],/append-only/);
    });
  }finally{await db.close();}
});

"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),B=require('../public/ui/regie-billing-state');
const base={actualHours:120,regieHours:20,fixedTargetHours:200,plannedRegieHours:40,contractAmount:22000,plannedRegieAmount:2000,actualRegieAmount:1800,partialInvoiceNet:4000};
test('fixed performance is hours without Regie / fixed target × fixed contract, then issued TR',()=>{
  const p=B.calculatePerformance(base);
  assert.equal(p.orderHours,100);assert.equal(p.completionPercent,50);assert.equal(p.orderPerformance,10000);
  assert.equal(p.fixedToInvoice,6000);assert.equal(p.regieToInvoice,1800);assert.equal(p.amountToInvoice,7800);
  assert.equal(p.hourlyRate,undefined);
});
test('overrun never silently raises a fixed contract by 10 percent',()=>{
  const p=B.calculatePerformance({...base,actualHours:240});
  assert(Math.abs(p.orderProgressPercent-110)<1e-9);assert.equal(p.orderPerformance,20000);assert.equal(p.amountToInvoice,17800);
});
test('Halter target example: both warnings start at 90 percent; 4 offered Regie hours remain',()=>{
  const p=B.calculatePerformance({...base,fixedTargetHours:602.53,actualHours:602.53*.9+36,regieHours:36});
  assert.deepEqual(p.warnings.map(x=>x.kind),['fixed','regie']);assert.equal(p.remainingRegieHours,4);
  assert.match(p.warnings[1].text,/Noch 4 Regiestunden offen/);
  assert.equal(B.calculatePerformance({...base,actualHours:179.9+35.9,regieHours:35.9}).warnings.length,0);
});
const job={jobId:'26082',name:'Testprojekt',calculation:{actualHours:120,actualRegieHours:20,fixedCalculatedHours:200,plannedRegieHours:40,contractAmount:22000,regieBudgetAmount:2000}};
const reports=[{id:'r1',source:'WW',sourceId:'r1',reportNumber:'1',totalHours:8,totalNet:700,billedDocumentId:'doc1'},{id:'r2',source:'WW',sourceId:'r2',reportNumber:'2',totalHours:12,totalNet:1100}];
const invoices=[{sourceId:'doc1',invoiceNumber:'TR1',kind:'TR',status:'issued',net:4000,paidGross:0},{invoiceNumber:'draft',kind:'TR',status:'draft',net:5000}];
test('mixed TR deducts its Regie reports exactly once; unpaid issued counts, draft does not',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices}});
  assert.equal(p.fixedPartialInvoiceNet,3300);assert.equal(p.regiePartialInvoiceNet,700);
  assert.equal(p.regieDeductions,700);assert.equal(p.fixedToInvoice,6700);assert.equal(p.regieToInvoice,1100);assert.equal(p.amountToInvoice,7800);
});
test('an explicit further Regie advance is separate from already billed report values',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices:[...invoices,{invoiceNumber:'TR2',kind:'TR',status:'issued',net:800,regieNet:500}]}});
  assert.equal(p.fixedPartialInvoiceNet,3600);assert.equal(p.additionalRegiePartialNet,500);assert.equal(p.regieToInvoice,600);assert.equal(p.amountToInvoice,7000);
});
test('draft linked report stays open and SR draft does not settle a project',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices:[{...invoices[0],status:'draft',kind:'SR'}]}});
  assert.equal(p.hasClosingInvoice,false);assert.equal(p.billedRegieAmount,0);assert.equal(p.regieToInvoice,1800);
});
test('pure Regie RE does not settle the fixed order',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices:[{...invoices[0],kind:'RE',net:700}]}});
  assert.equal(p.hasClosingInvoice,false);assert.equal(p.fixedPartialInvoiceNet,0);assert.equal(p.amountToInvoice,11100);
  assert.equal(B.performanceForJob(job,{reports,billing:{invoices:[{...invoices[0],kind:'SR'}]}}).amountToInvoice,0);
});
test('missing target and partial invoice sources produce unknown instead of a false zero',()=>{
  for(const p of [B.calculatePerformance({...base,fixedTargetHours:0}),B.calculatePerformance({...base,partial:true})]){
    assert.equal(p.complete,false);assert.equal(p.amountToInvoice,null);assert(p.issues.length);
  }
});
test('pure Regie remains billable when report hours exceed missing time-clock hours',()=>{
  const p=B.calculatePerformance({actualHours:0,regieHours:18,fixedTargetHours:0,contractAmount:0,fixedContractAmount:0,actualRegieAmount:2581});
  assert.equal(p.complete,true);assert.equal(p.amountToInvoice,2581);assert.deepEqual(p.issues,[]);
});
test('signed balances and clamped payable amounts are explained separately',()=>{
  const p=B.calculatePerformance({...base,partialInvoiceNet:12000});
  assert.equal(p.fixedBalance,-2000);assert.equal(p.fixedToInvoice,0);assert.equal(p.amountToInvoice,1800);
  assert.match(B.downloadText(p),/Saldo; jetzt abrechenbar/);assert(!B.compactCalculation(p).includes('12.000'));
});
test('S sums project billing, including settled members with zero remaining; incomplete stays unknown',()=>{
  const open=B.calculatePerformance(base),closed=B.calculatePerformance({...base,hasClosingInvoice:true});
  assert.equal(B.aggregatePerformance([open,closed]).amountToInvoice,7800);
  assert.equal(B.aggregatePerformance([open,closed]).hasClosingInvoice,false);
  assert.equal(B.aggregatePerformance([open,B.calculatePerformance({...base,partial:true})]).amountToInvoice,null);
});
test('TR correction and SR100 preserve baseline; download carries the corrected arithmetic',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices}});
  const tr=B.prepareInvoiceProposal(p,{completionPercent:60,regieToInvoice:900,reason:'Stand vor Ort geprüft'});
  assert.equal(tr.fixedToInvoice,8700);assert.equal(tr.amountToInvoice,9600);assert.equal(p.completionPercent,50);
  assert.match(B.proposalText(tr),/Stand vor Ort geprüft/);
  const sr=B.prepareInvoiceProposal(p,{kind:'SR',completionPercent:5});
  assert.equal(sr.completionPercent,100);assert.equal(sr.fixedToInvoice,16700);assert.equal(sr.amountToInvoice,17800);
  assert.throws(()=>B.prepareInvoiceProposal(p,{completionPercent:1}),/unter den bereits/);
  assert.throws(()=>B.prepareInvoiceProposal(p,{regieToInvoice:NaN}),/Regiebetrag/);
});
test('invoice snapshot excludes drafts and payments, so unchanged unpaid TR does not become stale',()=>{
  const a=B.invoiceSnapshot(invoices),b=B.invoiceSnapshot(invoices.map(x=>({...x,paidGross:9999})));assert.deepEqual(a,b);assert.equal(a.length,1);
});
test('visible labor and material breakdown is the Regie amount, not a differing PDF total',()=>{
  assert.equal(B.reportAmount({laborCost:24543.75,materialCost:6469,totalNet:31012.62}),31012.75);
  assert.equal(B.reportAmount({totalNet:929}),929);
});
test('manual report status overrides automatic WW/PDF status and stays calculable',()=>{
  const state=B.summarize([
    {id:'a',source:'WW',reportNumber:'1',totalNet:100,billedDocumentId:'doc',billingStatus:'open'},
    {id:'b',source:'PDF',reportNumber:'2',totalNet:200,billingStatus:'billed'},
  ],{invoices:[]});
  assert.equal(state.openRows[0].report.id,'a');assert.equal(state.billedRows[0].report.id,'b');assert.equal(state.unknownRows.length,0);
});
test('old TR without report IDs allocates billed Regie first and leaves the correct fixed balance',()=>{
  const halter={jobId:'25001',name:'Halter',calculation:{actualHours:478,actualRegieHours:392.6,fixedCalculatedHours:570.95,plannedRegieHours:430,contractAmount:92379.94,regieBudgetAmount:40850}};
  const halterReports=[
    {id:'r1',source:'WW',reportNumber:'1',sheetNumber:'1',totalHours:327.25,laborCost:24543.75,materialCost:6469,billedDocumentId:'old-ww-tr'},
    {id:'r14',source:'WW',reportNumber:'14',sheetNumber:'14',totalHours:65.35,laborCost:4901.25,materialCost:1089},
  ];
  const p=B.performanceForJob(halter,{reports:halterReports,billing:{invoices:[{invoiceNumber:'TR1',kind:'TR',status:'issued',net:34569}]}});
  assert.equal(p.billedRegieAmount,31012.75);assert.equal(p.regieToInvoice,5990.25);
  assert.equal(p.regiePartialInvoiceNet,31012.75);assert.equal(p.fixedPartialInvoiceNet,3556.25);assert.equal(p.complete,true);
  assert.equal(p.fixedTargetHours,571);assert.equal(p.orderPerformance,7706.93);
  assert.equal(p.billablePerformance,44709.93);assert.equal(p.fixedToInvoice,4150.68);assert.equal(p.amountToInvoice,10140.93);
  assert.equal(p.billedRegieRange,'1');assert.equal(p.openRegieRange,'14');
  assert.match(B.renderCalculation(p),/Leistungssumme gesamt/);assert.match(B.renderCalculation(p),/Teilrechnung vorbereiten/);
});
test('Halter live stand keeps the reviewed whole-percent progress and legacy invoice rounding',()=>{
  const halter={jobId:'26082',name:'Halter',calculation:{actualHours:480.3,actualRegieHours:392.6,fixedCalculatedHours:570.95,plannedRegieHours:430,contractAmount:92379.94,kristaAmount:51529.94,regieBudgetAmount:40850}};
  const reports=[
    {id:'r1',source:'WW',projectNumber:'26082',reportNumber:'M 01',sheetNumber:'1',totalHours:327.25,laborCost:24543.75,materialCost:6468.87,billedDocumentId:'old-ww-tr'},
    {id:'r14',source:'PDF',projectNumber:'26082',reportNumber:'26082014',totalHours:19.1,laborCost:1432.5,materialCost:130.58},
    {id:'r15',source:'PDF',projectNumber:'26082',reportNumber:'26082015',totalHours:46.25,laborCost:3468.75,materialCost:958.64,billingStatus:'open'},
  ];
  const p=B.performanceForJob(halter,{reports,billing:{invoices:[{invoiceNumber:'TR alt',kind:'TR',status:'issued',net:34568.85}]}});
  assert.equal(p.fixedContractAmount,51529.94);assert.equal(p.plannedRegieAmount,40850);assert.equal(p.fixedTargetHours,571);
  assert(Math.abs(p.completionPercent-((480.3-392.6)/571*100))<1e-9);assert.equal(p.orderPerformance,7914.49);
  assert.equal(p.billedRegieAmount,31012.75);assert.equal(p.regieToInvoice,5990.25);
  assert.equal(p.billablePerformance,44917.49);assert.equal(p.partialInvoiceNet,34569);assert.equal(p.amountToInvoice,10348.49);
  assert.equal(p.openRegieRange,'14–15');assert.equal(p.complete,true);
  assert.match(B.renderCalculation(p),/15 % von/);
});
test('a direct Rechnung proposal carries the customer-portal note',()=>{
  const p=B.performanceForJob(job,{reports,billing:{invoices}}),proposal=B.prepareInvoiceProposal(p,{kind:'RE'});
  assert.equal(proposal.kind,'RE');assert.match(proposal.customerNote,/Kundenportal/);
  assert.deepEqual(proposal.reportIdsToBill,['r2']);
  assert.deepEqual(B.prepareInvoiceProposal(p,{kind:'RE',regieToInvoice:500}).reportIdsToBill,[]);
});

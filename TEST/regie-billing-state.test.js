"use strict";

const assert=require("node:assert/strict");
const test=require("node:test");
const {summarize,calculatePerformance,dedupeReports}=require("../public/ui/regie-billing-state");

test("merges a synced WW report with its imported PDF original",()=>{
  const reports=dedupeReports([
    {reportNumber:"M 08",sheetNumber:"8",reportDate:"2026-08-26",source:"WW",totalHours:19,totalNet:1575,billedDocumentId:"DOC-1"},
    {reportNumber:"202609001/8",reportDate:"2026-08-26",source:"PDF",totalHours:19,totalNet:1575,url:"/admin/pdf/report-8"},
  ]);
  assert.equal(reports.length,1);
  assert.equal(reports[0].source,"WW");
  assert.equal(reports[0].url,"/admin/pdf/report-8");
  assert.equal(reports[0].hasPdfCopy,true);
  assert.deepEqual(reports[0].sourceCopies,["WW","PDF"]);
  const result=summarize(reports,{invoices:[{sourceId:"DOC-1",invoiceNumber:"TR 1"}]});
  assert.equal(result.rows.length,1);
  assert.equal(result.totalAmount,1575);
  assert.equal(result.billedHours,19);
});

test("links rapports to the exact WinWorker invoice and sums only open reports",()=>{
  const result=summarize([
    {reportNumber:"1",reportDate:"2026-08-01",source:"WW",totalHours:8,totalNet:700,billedDocumentId:"{AA-BB}"},
    {reportNumber:"2",reportDate:"2026-08-02",source:"WW",totalHours:6,laborCost:450,materialCost:75,billedDocumentId:""},
  ],{invoices:[{kind:"TR",invoiceNumber:"2026007",sourceId:"aa-bb"}]});
  assert.equal(result.rows[0].invoice.invoiceNumber,"2026007");
  assert.equal(result.billedAmount,700);
  assert.equal(result.openAmount,525);
  assert.equal(result.openHours,6);
  assert.equal(result.billedThrough.report.reportNumber,"1");
  assert.equal(result.hasGap,false);
});

test("does not claim a through-boundary when billed reports have a gap",()=>{
  const result=summarize([
    {reportNumber:"1",reportDate:"2026-08-01",source:"WW",totalNet:100,billedDocumentId:"A"},
    {reportNumber:"2",reportDate:"2026-08-02",source:"WW",totalNet:200},
    {reportNumber:"3",reportDate:"2026-08-03",source:"WW",totalNet:300,billedDocumentId:"B"},
  ]);
  assert.equal(result.hasGap,true);
  assert.equal(result.billedThrough,null);
  assert.equal(result.openAmount,200);
});

test("does not mark PDF-only reports or a zero GUID as billed",()=>{
  const result=summarize([
    {reportNumber:"PDF",source:"PDF",totalNet:400},
    {reportNumber:"WW",source:"WW",totalNet:250,billedDocumentId:"00000000-0000-0000-0000-000000000000"},
  ]);
  assert.equal(result.unknownRows.length,1);
  assert.equal(result.openRows.length,1);
  assert.equal(result.openAmount,250);
  assert.equal(result.billedRows.length,0);
});

test("calculates billable performance from non-regie hours and subtracts partial invoices",()=>{
  const result=calculatePerformance({actualHours:120,regieHours:20,hourlyRate:72,contractAmount:10000,plannedRegieAmount:1000,actualRegieAmount:1500,partialInvoiceNet:4000});
  assert.equal(result.orderHours,100);
  assert.equal(result.hourlyRate,85);
  assert.equal(result.orderPerformance,7650);
  assert.equal(result.excessRegieAmount,500);
  assert.equal(result.performanceBeforeCap,9150);
  assert.equal(result.performanceLimit,11500);
  assert.equal(result.billablePerformance,9150);
  assert.equal(result.amountToInvoice,5150);
});

test("caps performance at 110 percent of order plus excess regie",()=>{
  const result=calculatePerformance({actualHours:220,regieHours:20,hourlyRate:85,contractAmount:10000,plannedRegieAmount:1000,actualRegieAmount:1800,partialInvoiceNet:3000});
  assert.equal(result.performanceBeforeCap,17100);
  assert.equal(result.performanceLimit,11800);
  assert.equal(result.billablePerformance,11800);
  assert.equal(result.amountToInvoice,8800);
});

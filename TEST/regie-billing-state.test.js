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
  const result=summarize(reports,{invoices:[{sourceId:"DOC-1",invoiceNumber:"TR 1",kind:"TR",status:"issued"}]});
  assert.equal(result.rows.length,1);
  assert.equal(result.totalAmount,1575);
  assert.equal(result.billedHours,19);
});

test("links rapports to the exact WinWorker invoice and sums only open reports",()=>{
  const result=summarize([
    {reportNumber:"1",reportDate:"2026-08-01",source:"WW",totalHours:8,totalNet:700,billedDocumentId:"{AA-BB}"},
    {reportNumber:"2",reportDate:"2026-08-02",source:"WW",totalHours:6,laborCost:450,materialCost:75,billedDocumentId:""},
  ],{invoices:[{kind:"TR",invoiceNumber:"2026007",sourceId:"aa-bb",status:"issued"}]});
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
  ],{invoices:[
    {sourceId:"A",kind:"TR",status:"issued"},
    {sourceId:"B",kind:"TR",status:"issued"},
  ]});
  assert.equal(result.hasGap,true);
  assert.equal(result.billedThrough,null);
  assert.equal(result.openAmount,200);
});

test("treats every report without a real invoice link as open",()=>{
  const result=summarize([
    {reportNumber:"PDF",source:"PDF",totalNet:400},
    {reportNumber:"WW",source:"WW",totalNet:250,billedDocumentId:"00000000-0000-0000-0000-000000000000"},
    {reportNumber:"Alt",source:"OTHER",totalNet:100},
  ]);
  assert.equal(result.unknownRows.length,0);
  assert.equal(result.openRows.length,3);
  assert.equal(result.openAmount,750);
  assert.equal(result.billedRows.length,0);
});

test("recognizes compact project report numbers and never displays an empty report as zero",()=>{
  const B=require("../public/ui/regie-billing-state");
  assert.equal(B.reportRange([{projectNumber:"26082",reportNumber:"26082014"},{projectNumber:"26082",reportNumber:"26082015"}]),"14–15");
  assert.equal(B.reportRange([{reportNumber:"PDF"}]),"");
});

test("uses whole-euro material subtotals for the reviewed Regie statement",()=>{
  const result=summarize([
    {source:"WW",reportNumber:"1",laborCost:24543.75,materialCost:6468.87,billedDocumentId:"old"},
    {source:"PDF",projectNumber:"26082",reportNumber:"26082014",laborCost:4901.25,materialCost:1089.22},
  ],{invoices:[{sourceId:"old",kind:"TR",status:"issued"}]});
  assert.equal(result.billedAmount,31012.75);
  assert.equal(result.openAmount,5990.25);
  assert.equal(result.totalAmount,37003);
});

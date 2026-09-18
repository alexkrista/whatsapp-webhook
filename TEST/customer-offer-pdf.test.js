"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{PDFDocument}=require("pdf-lib");
const {createCustomerOfferPdf,offerTotals}=require("../customer-offer-pdf");

test("customer offer PDF is a real portrait A4 document",async()=>{
 const draft={offerNumber:"2609002",offerRevision:1,offerCreatedAt:"2026-09-18T10:00:00Z",intro:"Wir haben die Arbeiten besichtigt und besprochen.",positions:[{groupName:"Regiearbeiten",text:"Fachgerechte Regiearbeiten",quantity:20,unit:"Std",unitPrice:75},{groupName:"Regiearbeiten",text:"Material und Maschinen",quantity:1,unit:"PA",unitPrice:300}],financials:{vatRate:20,discountPercent:5}};
 const totals=offerTotals(draft);assert.equal(totals.gross,2052);
 const bytes=await createCustomerOfferPdf({draft,meta:{jobId:"26100",name:"Birgit Oberhauser",street:"Römerweg",houseNumber:"42",postalCode:"6833",city:"Klaus",customerPortal:{customerName:"Birgit Oberhauser"}}});assert.equal(bytes.subarray(0,4).toString(),"%PDF");
 const pdf=await PDFDocument.load(bytes),page=pdf.getPage(0),{width,height}=page.getSize();assert(Math.abs(width-595.28)<0.1);assert(Math.abs(height-841.89)<0.1);assert(width<height);
});

"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM}=require("jsdom");
(async()=>{
 const dom=new JSDOM("<!doctype html><html><body><div class='commercialActions'></div></body></html>",{
   url:"https://protokoll.krista.at/admin/paint",runScripts:"outside-only"
 });
 const window=dom.window;
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 window.confirm=()=>true;
 const order={id:"LG-20261013-001",status:"sent",fingerprint:"original",
   fileName:"LG",total:41.5,positions:[{sku:"020603DDDDD",quantity:2,
     unitPrice:20.75,lineTotal:41.5,product:"Absolute Matt"}]};
 let receipts=[
   {id:"receipt-open",invoiceRef:"CIN000628236",status:"awaiting_goods",
     orderId:order.id,netAmount:1289.92,revision:"r1",
     lines:[{sku:"020603DDDDD",quantity:2,unitPrice:20.75,product:"Absolute Matt"}]},
   {id:"receipt-booked",invoiceRef:"CIN000628894",status:"received",
     orderId:"LG-20260929-001",netAmount:1112.58,receivedAt:"2026-10-13T11:00:00.000Z",
     lines:[{sku:"020603TTTTT",quantity:1,unitPrice:19.02,product:"Absolute Matt"}]},
 ];
 const requests=[];
 window.fetch=async(url,opts)=>{
   const pathname=new URL(url,window.location.origin).pathname;
   let data;
   if(pathname==="/admin/api/paint/sent-orders")data={ok:true,orders:[order]};
   else if(pathname==="/admin/api/paint/goods-receipts")data={ok:true,receipts};
   else if(pathname==="/admin/api/paint/lg-invoice-candidates")data={ok:true,invoices:[],windowStart:"2026-09-22"};
   else if(pathname.endsWith("/receipt-open/confirm")){
     requests.push(JSON.parse(opts.body));
     receipts=receipts.map(r=>r.id==="receipt-open" ?
       {...r,status:"received",receivedAt:"2026-10-13T12:00:00Z"}:r);
     data={ok:true};
   }else throw Error("Unexpected "+pathname);
   return {ok:true,json:async()=>data};
 };
 window.eval(fs.readFileSync(path.join(__dirname,"..","public","paint-goods-receipt-ui.js"),"utf8"));
 window.document.getElementById("lgPurchasesOpen").click();
 await new Promise(resolve=>setTimeout(resolve,50));
 const receiptHost=window.document.querySelector("[data-receipts]");
 const archive=receiptHost.querySelector("[data-lg-received-archive]");
 assert.ok(archive,"A separate archive should exist");
 assert.equal(archive.open,false,"The archive must be collapsed by default");
 assert.equal(receiptHost.querySelectorAll("[data-receipt]").length,1,"Only unbooked receipts appear in the open area");
 assert.equal(receiptHost.querySelectorAll("[data-receipt-archived]").length,1);
 assert.match(receiptHost.textContent,/Offene Wareneingänge \(1\)/);
 assert.match(archive.textContent,/CIN000628894/);
 assert.ok(!receiptHost.querySelector("[data-receipt-archived] [data-confirm]"),"No booking action in the archive");
 receiptHost.querySelector("[data-receipt] [data-confirm]").click();
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(requests.length,1,"One confirmed posting");
 const refreshed=window.document.querySelector("[data-receipts]");
 assert.equal(refreshed.querySelectorAll("[data-receipt]").length,0,"Completed receipt disappears from open");
 assert.equal(refreshed.querySelectorAll("[data-receipt-archived]").length,2,"Both receipts remain in archive");
 assert.equal(refreshed.querySelector("[data-lg-received-archive]").open,false,"Archive remains collapsed after booking");
 console.log("LG booked receipts disappear from open and remain in collapsed archive");
 dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});

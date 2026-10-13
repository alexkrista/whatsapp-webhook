"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM}=require("jsdom");
(async()=>{
 const dom=new JSDOM("<!doctype html><html><body><div class='commercialActions'></div></body></html>",{
   url:"https://protokoll.krista.at/admin/paint",runScripts:"outside-only"
 });
 const w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.confirm=()=>true;
 w.prompt=()=>{throw Error("The invoice number must be selected, not typed");};
 const order={id:"LG-20261013-001",status:"sent",fingerprint:"fp",
   fileName:"Little Greene",total:41.5,
   positions:[{sku:"020603DDDDD",quantity:2,unitPrice:20.75,product:"Absolute Matt",lineTotal:41.5}]};
 const posted=[];
 w.fetch=async(url,init)=>{
   const pathname=new URL(url,w.location.origin).pathname;
   let data;
   if(pathname==="/admin/api/paint/sent-orders")data={ok:true,orders:[order]};
   else if(pathname==="/admin/api/paint/goods-receipts")data={ok:true,receipts:[]};
   else if(pathname==="/admin/api/paint/lg-invoice-candidates")data={ok:true,
     windowStart:"2026-09-22",syncedAt:new Date().toISOString(),
     invoices:[
       {invoiceRef:"CIN000628236",invoiceDate:"2026-09-30",netAmount:1289.92,
         positionCount:22,paymentStatus:"Bezahlt (Vorauskassa)",matchingOrderIds:[]},
       {invoiceRef:"CIN000628894",invoiceDate:"2026-09-30",netAmount:1112.58,
         positionCount:22,paymentStatus:"Bezahlt (Vorauskassa)",matchingOrderIds:[order.id]}
     ]};
   else if(pathname.includes("/prepare-goods-receipt")){
     posted.push(JSON.parse(init.body));
     data={ok:true,receipt:{id:"receipt1",invoiceRef:posted[0].invoiceRef},awaitingGoods:true};
   } else throw Error("Unknown URL "+pathname);
   return {ok:true,json:async()=>data};
 };
 const js=fs.readFileSync(path.join(__dirname,"..","public","paint-goods-receipt-ui.js"),"utf8");
 w.eval(js);
 w.document.querySelector("#lgPurchasesOpen").click();
 await new Promise(resolve=>setTimeout(resolve,30));
 w.document.querySelector("[data-open-order]").click();
 const prepare=[...w.document.querySelectorAll("#lgPurchasesOpen~* button, dialog button")]
   .find(button=>button.textContent==="Ware da – einbuchen?");
 assert.ok(prepare,"The new order button must exist");
 prepare.click();
 const picker=w.document.querySelector("[data-lg-invoice-picker]");
 assert.ok(picker,"A selectable invoice list must open");
 const options=picker.querySelectorAll("select option");
 assert.equal(options.length,3,"Both invoices must be in the list");
 assert.equal(picker.querySelector("select").value,"CIN000628894","Matching order suggested first");
 assert.match(picker.textContent,/vor 21 Tagen/);
 const accept=[...picker.querySelectorAll("button")].find(button=>/übernehmen/i.test(button.textContent));
 accept.click();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.deepEqual(posted,[{invoiceRef:"CIN000628894",fingerprint:"fp",fromInvoiceSelection:true}]);
 console.log("LG invoice dropdown offers both paid open invoices without manual number entry");
 dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1});

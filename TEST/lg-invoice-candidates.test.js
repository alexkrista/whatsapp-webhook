"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const express=require("express");
const {registerPaintInventory}=require("../paint-inventory");
const {cutoffVienna}=require("../paint-lg-invoice-candidates");
(async()=>{
 process.env.ADMIN_TOKEN="lg-candidate-test-admin";
 process.env.KRISTINE_LG_CANDIDATES_TOKEN="lg-candidate-test-bridge";
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lg-select-"));
 const paint=path.join(dir,"_kristine","paint");
 fs.mkdirSync(paint,{recursive:true});
 const sku="020603DDDDD",id="LG-A";
 fs.writeFileSync(path.join(paint,"articles.json"),JSON.stringify([
   {id,stockCode:sku,product:"Absolute Matt",manufacturer:"Little Greene",
    baseCode:"D",baseName:"Deep",size:"1 L",stock:3,purchasePrice:20,active:true}
 ]));
 const order={id:"LG-20261013-001",status:"sent",fingerprint:"fingerprint-lg",
   total:41.50,positions:[{articleId:id,sku,quantity:2,unitPrice:20.75,lineTotal:41.50}]};
 fs.writeFileSync(path.join(paint,"lg-sent-orders.json"),JSON.stringify([order]));
 const app=express();app.use(express.json());
 registerPaintInventory(app,{dataDir:dir});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+server.address().port;
 const req=async (route,body,token="admin")=>{
   const res=await fetch(base+route,{
     method:body===undefined?"GET":"POST",
     headers:{"Content-Type":"application/json",
       ...(token==="bridge"?{"x-krista-lg-candidates-token":"lg-candidate-test-bridge"}:
         {"x-admin-token":"lg-candidate-test-admin"})},
     ...(body===undefined?{}:{body:JSON.stringify(body)})
   });
   return {status:res.status,body:await res.json()};
 };
 const dayOffset=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
 const invoice=(ref,date)=>({
    invoiceRef:ref,invoiceDate:date,netAmount:41.50,paymentStatus:"Bezahlt (Vorauskassa)",
    sourceInvoiceId:99,lines:[{sku,quantity:2,unitPrice:20.75,net:41.50}]
 });
 try{
   const forbidden=await req("/admin/api/paint/lg-invoice-candidates/sync",{invoices:[]});
   assert.equal(forbidden.status,403,"Admin token cannot replace secured Brain upload");
   const old=dayOffset(-40),future=dayOffset(40);
   const upload=await req("/admin/api/paint/lg-invoice-candidates/sync",{invoices:[
     invoice("CIN-RECENT-2026",dayOffset(-2)),
     invoice("CIN-OLD-2026",old),invoice("CIN-FUTURE-2027",future)
   ]},"bridge");
   assert.equal(upload.status,200,upload.body.error);
   let list=(await req("/admin/api/paint/lg-invoice-candidates")).body;
   assert.deepEqual(list.invoices.map(row=>row.invoiceRef),["CIN-FUTURE-2027","CIN-RECENT-2026"]);
   assert.equal(list.invoices[1].paymentStatus,"Bezahlt (Vorauskassa)");
   assert.equal(list.windowStart,cutoffVienna());
   const prepare=await req("/admin/api/paint/sent-orders/"+order.id+"/prepare-goods-receipt",{
     fromInvoiceSelection:true,invoiceRef:"CIN-RECENT-2026",fingerprint:order.fingerprint
   });
   assert.equal(prepare.status,200,prepare.body.error);
   assert.equal(prepare.body.receipt.amountSource,"invoice");
   assert.equal(prepare.body.receipt.lines.length,1);
   const stock=()=>JSON.parse(fs.readFileSync(path.join(paint,"articles.json")))[0].stock;
   assert.equal(stock(),3,"Selection does not change warehouse stock");
   const confirmPath="/admin/api/paint/goods-receipts/"+prepare.body.receipt.id+"/confirm";
   const confirm=await req(confirmPath,{goodsReceived:true,revision:prepare.body.receipt.revision,orderId:order.id});
   assert.equal(confirm.status,200,confirm.body.error);
   assert.equal(stock(),5,"All invoice quantities booked only on final explicit confirmation");
   const repeat=await req(confirmPath,{goodsReceived:true,revision:prepare.body.receipt.revision,orderId:order.id});
   assert.equal(repeat.body.duplicate,true);
   assert.equal(stock(),5,"No double booking on retry");
   list=(await req("/admin/api/paint/lg-invoice-candidates")).body;
   assert.equal(list.invoices.some(row=>row.invoiceRef==="CIN-RECENT-2026"),false,"Booked invoice is no longer selectable");
   assert.equal(list.invoices.some(row=>row.invoiceRef==="CIN-FUTURE-2027"),true,"Future dates have no end cap");
   console.log("LG rolling invoice dropdown, paid invoices, preparation, one-time booking and deduplication passed");
 }finally{
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

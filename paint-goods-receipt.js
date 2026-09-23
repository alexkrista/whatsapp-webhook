"use strict";
const fs = require("fs/promises"), path = require("path"), crypto = require("crypto");
const {readLatestStockMap, stockForArticle} = require("./paint-stock-ledger");
const {withOrderLock} = require("./paint-order-lock");
function registerPaintGoodsReceipt(app, {dataDir, parseLines}) {
  const root=path.join(dataDir,"_kristine","paint"), file=path.join(root,"lg-goods-receipts.json");
  const tasksFile=path.join(dataDir,"_kristine","tasks.json");
  const auth=require("./admin-auth").requireAdmin;
  async function read(p, fallback){try{return JSON.parse(await fs.readFile(p,"utf8"));}catch(e){if(e.code==="ENOENT")return fallback;throw e;}}
  async function write(p,value){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+"."+crypto.randomUUID()+".tmp";await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,p);}
  function serial(fn){return withOrderLock(root,fn);}
  function wrap(fn){return async(req,res)=>{if(!auth(req,res))return;try{res.json({ok:true,...await serial(()=>fn(req))});}catch(e){res.status(e.status||400).json({ok:false,error:e.message});}};}
  const round=n=>Math.round(Number(n)*1000)/1000;
  const rev=r=>crypto.createHash("sha256").update(JSON.stringify([r.invoiceRef,r.invoiceDate,r.netAmount,r.lines])).digest("hex");
  async function task(receipt,done=false){
    const tasks=await read(tasksFile,[]), id="lg_receipt_"+receipt.id;
    let t=tasks.find(t=>t.id===id);
    if(!t){const employees=await read(path.join(dataDir,"_kristine","employees.json"),[]);const alex=employees.find(e=>e.active!==false&&/^(alexander krista|alex krista|alex)$/i.test(e.name||""));t={id,createdAt:new Date().toISOString(),assigneeId:alex?.id||"admin",assigneeName:alex?.name||"Alexander Krista",creatorId:"lg-invoice",creatorName:"LG Rechnungseingang",taskType:"Sonstiges",priority:"heute",jobId:"",jobName:""};tasks.push(t);}
    t.title="Ware da? · Little Greene · "+receipt.invoiceRef;
    t.reminder="Farben & Lager → Bestellungen & Wareneingang. Lieferung prüfen und dort ausdrücklich einbuchen. Rechnung allein erhöht den Lagerstand nicht.";
    t.status=done?"done":"open";t.completedAt=done?new Date().toISOString():null;
    t.goodsReceiptId=receipt.id;await write(tasksFile,tasks);
  }
  app.get("/admin/api/paint/goods-receipts",wrap(async()=>({receipts:await read(file,[])})));
  app.post("/admin/api/paint/lg-incoming-sync",wrap(async req=>{
    const b=req.body||{}, invoiceRef=String(b.invoiceRef||b.invoiceNumber||"").trim().slice(0,120), invoiceDate=String(b.invoiceDate||"").slice(0,10), netAmount=Number(b.netAmount);
    if(!invoiceRef||!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)||!Number.isFinite(netAmount))throw Error("Rechnungsnummer, Datum und Netto erforderlich");
    const legacy=await read(path.join(root,"lg-incoming-sync.json"),{});
    if(legacy[invoiceRef])return {duplicate:true,invoiceRef,previous:legacy[invoiceRef],alreadyBooked:true};
    const receipts=await read(file,[]), id=crypto.createHash("sha256").update(invoiceRef).digest("hex").slice(0,24);
    let r=receipts.find(x=>x.id===id);
    if(r?.status==="received")return {duplicate:true,receipt:r};
    if(r?.status==="booking")throw Error("Lagerbuchung wird abgeschlossen. Bitte den Wareneingang erneut bestätigen.");
    const articles=await read(path.join(root,"articles.json"),[]);
    const lines=parseLines(String(b.text||""),articles).map(x=>({articleId:x.article?.id||"",sku:x.stockCode,product:x.article?.product||x.description,size:x.size,baseName:x.base,quantity:round(x.quantity),unitPrice:Number(x.purchasePrice)}));
    const valid=lines.length&&lines.every(x=>x.articleId&&Number.isFinite(x.quantity)&&x.quantity>0&&Number.isFinite(x.unitPrice)&&x.unitPrice>=0);
    const next={id,invoiceRef,invoiceDate,netAmount,sourceInvoiceId:b.sourceInvoiceId||null,lines,status:"awaiting_goods",createdAt:r?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),issue:valid?"":"Rechnungspositionen sind nicht vollständig erkannt. Vor dem Einbuchen klären."};
    next.revision=rev(next);if(r)Object.assign(r,next);else{r=next;receipts.push(r);}
    await write(file,receipts);await task(r);
    return {invoiceRef,paintLines:lines.length,awaitingGoods:true,receipt:r};
  }));
  app.post("/admin/api/paint/goods-receipts/:id/confirm",wrap(async req=>{
    if(req.body?.goodsReceived!==true)throw Error("Bitte den vollständigen Wareneingang ausdrücklich bestätigen.");
    const receipts=await read(file,[]), r=receipts.find(x=>x.id===req.params.id);
    if(!r)throw Error("Wareneingang nicht gefunden");
    if(r.status==="received"){await task(r,true);return {duplicate:true,receipt:r};}
    if(req.body.revision!==r.revision)throw Error("Die Rechnung wurde geändert. Bitte neu laden und prüfen.");
    if(r.issue||!r.lines.length)throw Error(r.issue||"Keine Lagerpositionen erkannt");
    const articlesFile=path.join(root,"articles.json"), articles=await read(articlesFile,[]), map=new Map(articles.map(a=>[a.id,a]));
    if(r.lines.some(x=>!map.has(x.articleId)))throw Error("Ein Lagerartikel fehlt. Bitte zuerst klären.");
    const orders=await read(path.join(root,"lg-sent-orders.json"),[]);
    const orderId=String(r.booking?r.orderId||"":req.body.orderId||"");const order=orderId?orders.find(o=>o.id===orderId):null;
    if(orderId&&!order)throw Error("Bestellung nicht gefunden");
    if(order&&(["invoiced","cancelled","superseded"].includes(order.status)||(order.status==="received"&&!(r.booking&&order.invoiceRef===r.invoiceRef))))throw Error("Diese Bestellung ist bereits abgeschlossen.");
    if(order){const totals=rows=>{const m=new Map();for(const x of rows.filter(x=>Number(x.quantity)>0))m.set(x.sku,round((m.get(x.sku)||0)+Number(x.quantity)));return m;};const a=totals(order.positions),b=totals(r.lines);if(a.size!==b.size||[...a].some(([k,v])=>b.get(k)!==v))throw Error("Rechnung und Bestellung haben unterschiedliche Mengen. Zuordnung bitte klären; die Bestellung bleibt offen.");}
    if(!r.booking){
      const latest=await readLatestStockMap(root), running=new Map();
      r.booking=r.lines.map((line,index)=>{const a=map.get(line.articleId),before=running.get(a.id)??stockForArticle(a,latest).stock,after=round(before+line.quantity);running.set(a.id,after);return {movementId:r.id+":"+index,at:new Date().toISOString(),articleId:a.id,ean:a.ean||"",product:a.product,baseCode:a.baseCode,size:a.size,direction:"in",quantity:line.quantity,delta:line.quantity,before,after,reason:"goods_received",invoiceRef:r.invoiceRef,purchasePrice:line.unitPrice,oldPurchasePrice:Number(a.purchasePrice||0),user:"Bestätigter LG-Wareneingang"};});
      r.orderId=orderId;r.status="booking";await write(file,receipts);
    }
    const movementsFile=path.join(root,"movements.jsonl");let ledger="";try{ledger=await fs.readFile(movementsFile,"utf8");}catch(e){if(e.code!=="ENOENT")throw e;}
    const booked=new Set(ledger.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line).movementId));
    const missing=r.booking.filter(m=>!booked.has(m.movementId));if(missing.length)await fs.appendFile(movementsFile,missing.map(m=>JSON.stringify(m)+"\n").join(""));
    const latest=await readLatestStockMap(root), fresh=await read(articlesFile,[]);
    for(const a of fresh){const line=r.lines.find(x=>x.articleId===a.id);if(line){a.stock=stockForArticle(a,latest).stock;a.purchasePrice=line.unitPrice;a.updatedAt=new Date().toISOString();}}
    const priceFile=path.join(root,"price-history.jsonl");let priceText="";
    try{priceText=await fs.readFile(priceFile,"utf8");}catch(e){if(e.code!=="ENOENT")throw e;}
    const priceIds=new Set(priceText.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line).movementId));
    const priceChanges=r.booking.filter(m=>m.purchasePrice!==m.oldPurchasePrice&&!priceIds.has(m.movementId)).map(m=>({movementId:m.movementId,at:m.at,articleId:m.articleId,oldPurchasePrice:m.oldPurchasePrice,newPurchasePrice:m.purchasePrice,invoiceRef:r.invoiceRef,source:"LG-Wareneingang"}));
    if(priceChanges.length)await fs.appendFile(priceFile,priceChanges.map(m=>JSON.stringify(m)+"\n").join(""));
    await write(articlesFile,fresh);
    if(order){order.status="received";order.receivedAt=new Date().toISOString();order.invoiceRef=r.invoiceRef;await write(path.join(root,"lg-sent-orders.json"),orders);}
    r.status="received";r.receivedAt=new Date().toISOString();await write(file,receipts);await task(r,true);
    return {receipt:r,results:r.booking};
  }));
}
module.exports={registerPaintGoodsReceipt};

"use strict";
const fs = require("fs/promises"), path = require("path"), crypto = require("crypto");
const {readLatestStockMap, stockForArticle} = require("./paint-stock-ledger");
const {withOrderLock} = require("./paint-order-lock");
const {createLgCandidateStore,requireLgCandidatesSync,cutoffVienna} = require("./paint-lg-invoice-candidates");
function registerPaintGoodsReceipt(app, {dataDir, parseLines}) {
  const root=path.join(dataDir,"_kristine","paint"), file=path.join(root,"lg-goods-receipts.json");
  const tasksFile=path.join(dataDir,"_kristine","tasks.json");
  const candidateStore=createLgCandidateStore(dataDir);
  const auth=require("./admin-auth").requireAdmin;
  async function read(p, fallback){try{return JSON.parse(await fs.readFile(p,"utf8"));}catch(e){if(e.code==="ENOENT")return fallback;throw e;}}
  async function write(p,value){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+"."+crypto.randomUUID()+".tmp";await fs.writeFile(tmp,JSON.stringify(value,null,2));await fs.rename(tmp,p);}
  function serial(fn){return withOrderLock(root,fn);}
  function wrap(fn,allowSync=false){return async(req,res)=>{if(!(allowSync?require("./paint-lg-service-auth").requirePaintLgSync(req,res):auth(req,res)))return;try{res.json({ok:true,...await serial(()=>fn(req))});}catch(e){res.status(e.status||400).json({ok:false,error:e.message});}};}
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

  // This endpoint receives only invoice selection metadata from authorized local Brain sync.
  // It creates no receipt, ledger movement, payment or stock posting.
  app.post("/admin/api/paint/lg-invoice-candidates/sync",async(req,res)=>{
    if(!requireLgCandidatesSync(req,res))return;
    try {
      const result=await candidateStore.replace(req.body?.invoices);
      res.json({ok:true,...result});
    }catch(error){res.status(400).json({ok:false,error:String(error.message||error)});}
  });
  app.get("/admin/api/paint/lg-invoice-candidates",wrap(async()=>{
    const data=await candidateStore.read(),receipts=await read(file,[]);
    const legacy=await read(path.join(root,"lg-incoming-sync.json"),{});
    const cutoff=cutoffVienna(),posted=new Set();
    const movementFile=path.join(root,"movements.jsonl");
    try {
      const records=(await fs.readFile(movementFile,"utf8")).split(/\r?\n/).filter(Boolean);
      for(const value of records){
        try {
          const row=JSON.parse(value);
          if(row.invoiceRef && row.reason==="goods_received")posted.add(String(row.invoiceRef).trim().toUpperCase());
        }catch{}
      }
    }catch(error){if(error.code!=="ENOENT")throw error;}
    const candidates=data.invoices.filter(row=>{
      const reference=row.invoiceRef.toUpperCase();
      if(row.invoiceDate<cutoff || Object.keys(legacy).some(key=>key.toUpperCase()===reference) || posted.has(reference))return false;
      return !receipts.some(r=>String(r.invoiceRef||"").trim().toUpperCase()===reference && r.status==="received");
    }).map(row=>{
      const receipt=receipts.find(r=>String(r.invoiceRef||"").trim().toUpperCase()===row.invoiceRef);
      return {invoiceRef:row.invoiceRef,invoiceDate:row.invoiceDate,netAmount:row.netAmount,
        paymentStatus:row.paymentStatus,positionCount:row.lines.length,
        status:receipt?.status==="booking"?"booking":receipt?"prepared":"open",
        linkedOrderId:receipt?.sourceOrderId||receipt?.orderId||"",
        issue:row.issue || receipt?.issue || ""};
    }).sort((a,b)=>b.invoiceDate.localeCompare(a.invoiceDate)||a.invoiceRef.localeCompare(b.invoiceRef));
    return {invoices:candidates,syncedAt:data.syncedAt,windowStart:cutoff};
  }));


  // A received order can be prepared for booking even when Brain's invoice
  // workflow did not generate an invoice-based receipt. Preparation NEVER books stock.
  app.post("/admin/api/paint/sent-orders/:id/prepare-goods-receipt",wrap(async req=>{
    const invoiceRef=String(req.body?.invoiceRef||"").trim().toUpperCase();
    const candidate=await candidateStore.find(invoiceRef);
    if(req.body?.fromInvoiceSelection===true && (!candidate||candidate.invoiceDate<cutoffVienna()))
      throw Error("Diese Rechnung steht nicht in der aktuellen offenen LG-Rechnungsauswahl. Bitte aktualisieren.");
    if(candidate?.issue)throw Error(candidate.issue+" Rechnung "+invoiceRef+" bitte zuerst prüfen.");

    if(!/^[A-Z0-9][A-Z0-9._/-]{2,99}$/.test(invoiceRef))throw Error("Bitte die originale LG-Rechnungsnummer eingeben.");
    const legacy=await read(path.join(root,"lg-incoming-sync.json"),{});
    if(Object.keys(legacy).some(key=>key.toUpperCase()===invoiceRef))throw Error("Diese Rechnung wurde bereits im früheren Lagerverfahren gebucht.");
    const orders=await read(path.join(root,"lg-sent-orders.json"),[]);
    const order=orders.find(row=>row.id===req.params.id);
    if(!order)throw Error("Bestellung nicht gefunden.");
    const receipts=await read(file,[]);
    const previousForOrder=receipts.find(row=>row.orderId===order.id||row.sourceOrderId===order.id);
    if(order.status==="received"){
      return {duplicate:true,alreadyBooked:true,receipt:previousForOrder||null};
    }
    if(order.status!=="sent")throw Error("Nur offene Bestellungen können eingebucht werden.");
    if(String(req.body?.fingerprint||"")!==String(order.fingerprint||""))throw Error("Bestellung wurde zwischenzeitlich geändert. Bitte neu öffnen.");
    if(previousForOrder && previousForOrder.invoiceRef.toUpperCase()!==invoiceRef)
      throw Error("Diese Bestellung ist bereits mit einer anderen Rechnung verknüpft.");
    const id=crypto.createHash("sha256").update(invoiceRef).digest("hex").slice(0,24);
    const existing=receipts.find(row=>row.id===id||String(row.invoiceRef||"").toUpperCase()===invoiceRef);
    if(existing && existing.orderId && existing.orderId!==order.id)
      throw Error("Diese Rechnung ist bereits einer anderen Bestellung zugeordnet.");
    if(existing?.status==="received")
      throw Error("Diese Rechnung wurde bereits als Wareneingang gebucht. Keine zweite Zubuchung.");
    if(existing?.status==="booking")throw Error("Lagerbuchung für diese Rechnung läuft bereits.");
    if(existing?.issue&&!candidate)throw Error("Rechnungspositionen sind nicht eindeutig. Bitte zuerst klären.");
    const articles=await read(path.join(root,"articles.json"),[]);
    const byId=new Map(articles.map(a=>[String(a.id||""),a]));
    const bySku=new Map();
    for(const article of articles){
      const sku=String(article.stockCode||"").trim().toUpperCase().replace(/\s+/g,"");
      if(!sku)continue;
      if(bySku.has(sku))bySku.set(sku,null);
      else bySku.set(sku,article);
    }
    const lines=[],seen=new Set();
    const sourcePositions=candidate ? candidate.lines : (order.positions||[]);
    for(const pos of sourcePositions){
      const quantity=Number(pos.quantity),unitPrice=Number(pos.unitPrice);
      if(!Number.isFinite(quantity)||quantity<0||!Number.isFinite(unitPrice)||unitPrice<0)
        throw Error("Ungültige Menge oder Einkaufspreis in der Rechnung/Bestellung.");
      if(quantity===0)continue;
      const sku=String(pos.sku||"").trim().toUpperCase().replace(/\s+/g,"");
      if(!sku||seen.has(sku))throw Error("SKU fehlt oder ist doppelt: "+sku);
      seen.add(sku);
      const article=byId.get(String(pos.articleId||""))||bySku.get(sku);
      if(!article||String(article.stockCode||"").replace(/\s+/g,"").toUpperCase()!==sku)
        throw Error("Material nicht eindeutig im Lagerstamm gefunden: "+sku);
      lines.push({articleId:article.id,sku,product:article.product||pos.product||sku,
        size:article.size||pos.size||"",baseName:article.baseName||pos.baseName||"",
        quantity:round(quantity),unitPrice:Number(unitPrice.toFixed(2))});
    }
    if(!lines.length)throw Error("Keine bestellten Materialmengen vorhanden.");
    const totals=rows=>{const map=new Map();
      for(const row of rows)if(Number(row.quantity)>0){
        const sku=String(row.sku||"").trim().toUpperCase().replace(/\s+/g,"");
        map.set(sku,round((map.get(sku)||0)+Number(row.quantity)));
      }return map;};
    if(candidate){
      const a=totals(order.positions||[]),b=totals(lines);
      if(a.size!==b.size||[...a].some(([sku,qty])=>b.get(sku)!==qty))
        throw Error("Die Rechnung "+invoiceRef+" stimmt bei Artikelmengen nicht mit der gewählten Bestellung überein. Bitte die richtige Bestellung auswählen oder zuerst die Positionen korrigieren.");
    }
    if(existing){
      const a=totals(existing.lines||[]),b=totals(lines);
      if(a.size!==b.size||[...a].some(([sku,qty])=>b.get(sku)!==qty)){
        if(!candidate||existing.booking)throw Error("Rechnungspositionen und Bestellung haben unterschiedliche Mengen. Bitte prüfen.");
        existing.lines=lines;existing.issue="";existing.invoiceDate=candidate.invoiceDate;
        existing.netAmount=candidate.netAmount;existing.amountSource="invoice";
        existing.revision=rev(existing);
      }
      existing.orderId=order.id;existing.sourceOrderId=order.id;
      await write(file,receipts);
      return {receipt:existing,duplicate:true,awaitingGoods:true};
    }
    const now=new Date().toISOString();
    const receipt={id,invoiceRef,invoiceDate:candidate?.invoiceDate||null,netAmount:candidate ? candidate.netAmount : (Number(order.total)||0),
      amountSource:candidate?"invoice":"order",sourceOrderId:order.id,orderId:order.id,sourceInvoiceId:candidate?.sourceInvoiceId||null,
      lines,status:"awaiting_goods",createdAt:now,updatedAt:now,issue:""};
    receipt.revision=rev(receipt);
    receipts.push(receipt);await write(file,receipts);await task(receipt);
    return {receipt,awaitingGoods:true,created:true};
  }));

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
  },true));
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
    if(r.sourceOrderId && orderId!==r.sourceOrderId)throw Error("Diese Warenlieferung muss mit ihrer ursprünglichen Bestellung gebucht werden.");
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

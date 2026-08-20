"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerPaintInventory(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const priceHistoryFile = path.join(root, "price-history.jsonl");
  const purchasesFile = path.join(root, "lg-purchases.json");
  const syncFile = path.join(root, "lg-incoming-sync.json");
  const docsDir = path.join(root, "price-lists");
  const wallpaperMetaFile = path.join(root, "wallpaper-pricelists.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok:false, error:"Forbidden" });
      return false;
    }
    return true;
  }
  const clean = (v, max=500) => String(v ?? "").trim().slice(0,max);
  const num = (v, fallback=0) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
    const raw = clean(v).replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",", ".");
    const n = Number(raw); return Number.isFinite(n) ? n : fallback;
  };
  const sizeNorm = value => {
    const raw=clean(value,50).toLowerCase().replace(/litre|liter|ltr/g,"l").replace(/\s+/g,"");
    if(/^250ml$|^0[.,]?25l$/.test(raw))return"0.25 L";
    if(/^500ml$|^0[.,]?5l$/.test(raw))return"0.5 L";
    if(/^750ml$|^0[.,]?75l$/.test(raw))return"0.75 L";
    if(/^1l$/.test(raw))return"1 L";
    if(/^2l$/.test(raw))return"2 L";
    if(/^2[.,]?5l$/.test(raw))return"2.5 L";
    if(/^4l$/.test(raw))return"4 L";
    if(/^5l$/.test(raw))return"5 L";
    if(/^10l$/.test(raw))return"10 L";
    return clean(value,50);
  };
  async function ensureRoot(){ await fsp.mkdir(root,{recursive:true}); await fsp.mkdir(docsDir,{recursive:true}); }
  async function readJson(file,fallback){ try{return JSON.parse(await fsp.readFile(file,"utf8"));}catch{return fallback;} }
  async function writeJson(file,value){ await ensureRoot(); const tmp=`${file}.tmp`; await fsp.writeFile(tmp,JSON.stringify(value,null,2),"utf8"); await fsp.rename(tmp,file); }
  async function appendJsonl(file,value){ await ensureRoot(); await fsp.appendFile(file,JSON.stringify(value)+"\n","utf8"); }

  function publicInventory(rows){
    return (Array.isArray(rows)?rows:[]).filter(a=>a&&a.active!==false).map(a=>{
      const target=Number(a.targetStock ?? a.minimumStock ?? 0);
      const minimum=Number(a.minimumStock ?? a.targetStock ?? 0);
      const stock=Number(a.stock||0);
      return {
        id:a.id||"", product:a.product||"", baseName:a.baseName||a.baseCode||"", baseCode:a.baseCode||"",
        size:sizeNorm(a.size), ean:a.ean||"", stockCode:a.stockCode||"", purchasePrice:Number(a.purchasePrice||0),
        targetStock:target, minimumStock:minimum, stock, difference:target-stock
      };
    }).sort((a,b)=>String(a.product).localeCompare(String(b.product),"de")||String(a.baseName).localeCompare(String(b.baseName),"de")||Number(parseFloat(b.size)||0)-Number(parseFloat(a.size)||0));
  }

  app.get("/admin/api/paint/inventory", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const rows=await readJson(articlesFile,[]);
    res.json({ok:true,items:publicInventory(rows),count:Array.isArray(rows)?rows.length:0});
  });

  app.post("/admin/api/paint/inventory/count", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const counts=Array.isArray(req.body?.rows)?req.body.rows:[];
      if(!counts.length)return res.status(400).json({ok:false,error:"Keine Ist-Staende uebergeben"});
      const articles=await readJson(articlesFile,[]);
      const byId=new Map(articles.map(a=>[String(a.id),a]));
      const changed=[];
      for(const row of counts){
        const a=byId.get(String(row.articleId||"")); if(!a)continue;
        const actual=num(row.stock,NaN); if(!Number.isFinite(actual)||actual<0)continue;
        const before=Number(a.stock||0); const after=Math.max(0,Math.round(actual*1000)/1000);
        a.stock=after; a.lastInventoryAt=new Date().toISOString(); a.updatedAt=a.lastInventoryAt;
        const movement={at:a.lastInventoryAt,articleId:a.id,ean:a.ean||"",product:a.product||"",baseCode:a.baseCode||"",size:a.size||"",direction:"inventory",quantity:Math.abs(after-before),delta:after-before,before,after,reason:"inventory_count",user:clean(req.body?.user||"Inventur",120)};
        await appendJsonl(movementsFile,movement); changed.push({articleId:a.id,before,after});
      }
      await writeJson(articlesFile,articles);
      res.json({ok:true,changed:changed.length,items:publicInventory(articles)});
    }catch(e){res.status(500).json({ok:false,error:String(e?.message||e)});}
  });

  app.get("/admin/api/paint/wallpaper-pricelist/status", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    res.json({ok:true,lists:await readJson(wallpaperMetaFile,{})});
  });

  app.post("/admin/api/paint/wallpaper-pricelist/import", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const kind=clean(req.body?.kind,20).toLowerCase();
      if(!["retail","trade"].includes(kind))return res.status(400).json({ok:false,error:"kind retail oder trade erforderlich"});
      const name=clean(req.body?.name||`LG-Wallpaper-${kind}.pdf`,180).replace(/[\\/:*?"<>|]+/g,"_");
      const base64=clean(req.body?.base64,120_000_000).replace(/^data:.*?;base64,/,"");
      if(!base64)return res.status(400).json({ok:false,error:"PDF fehlt"});
      const ext=path.extname(name).toLowerCase(); if(ext!==".pdf")return res.status(400).json({ok:false,error:"Bitte PDF verwenden"});
      await ensureRoot(); const stored=path.join(docsDir,`wallpaper-${kind}.pdf`); await fsp.writeFile(stored,Buffer.from(base64,"base64"));
      const meta=await readJson(wallpaperMetaFile,{}); meta[kind]={name,stored,importedAt:new Date().toISOString()}; await writeJson(wallpaperMetaFile,meta);
      res.json({ok:true,kind,...meta[kind]});
    }catch(e){res.status(500).json({ok:false,error:String(e?.message||e)});}
  });

  app.get("/admin/api/paint/wallpaper-pricelist/:kind", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const kind=clean(req.params.kind,20).toLowerCase(); const meta=await readJson(wallpaperMetaFile,{}); const row=meta[kind];
    if(!row?.stored||!fs.existsSync(row.stored))return res.status(404).send("Keine Tapeten-Preisliste importiert");
    res.setHeader("Content-Disposition",`inline; filename=\"${path.basename(row.name||row.stored)}\"`); res.sendFile(path.resolve(row.stored));
  });

  function parseLgPaintLines(text,articles){
    const byCode=new Map(articles.map(a=>[clean(a.stockCode,100).toUpperCase(),a]));
    const lines=[];
    const re=/^([A-Z0-9]{8,20})\s+LG\s+(.+?)\s+(Hi White|Medium|Deep|Extra Deep|Transparent|Yellow|Pastel|White ASP)\s+(250ml|500ml|750ml|1L|2L|2\.5L|4L|5L|10L)\s+([0-9.,]+)\s+([0-9.,]+)\s+([0-9.,]+)/i;
    for(const rawLine of String(text||"").split(/\r?\n/)){
      const m=rawLine.trim().match(re); if(!m)continue;
      const stockCode=m[1].toUpperCase(), article=byCode.get(stockCode)||null;
      lines.push({stockCode,description:m[2].trim(),base:m[3],size:sizeNorm(m[4]),quantity:num(m[5]),purchasePrice:num(m[6]),net:num(m[7]),article});
    }
    return lines;
  }

  app.post("/admin/api/paint/lg-incoming-sync", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const invoiceRef=clean(req.body?.invoiceRef||req.body?.invoiceNumber,120);
      const invoiceDate=clean(req.body?.invoiceDate,20).slice(0,10);
      const netAmount=num(req.body?.netAmount,NaN);
      const text=String(req.body?.text||"");
      if(!invoiceRef||!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)||!Number.isFinite(netAmount))return res.status(400).json({ok:false,error:"invoiceRef, invoiceDate und netAmount erforderlich"});
      const sync=await readJson(syncFile,{}); if(sync[invoiceRef])return res.json({ok:true,duplicate:true,invoiceRef,previous:sync[invoiceRef]});
      const articles=await readJson(articlesFile,[]); const lines=parseLgPaintLines(text,articles); const unmatched=lines.filter(x=>!x.article);
      if(unmatched.length)return res.status(409).json({ok:false,error:"LG-Rechnung enthaelt unbekannte Lagerartikel",unmatched:unmatched.map(x=>({stockCode:x.stockCode,description:x.description,base:x.base,size:x.size,quantity:x.quantity}))});
      const results=[];
      for(const line of lines){
        const a=line.article, before=Number(a.stock||0), qty=Math.max(0,Number(line.quantity||0)), oldPrice=Number(a.purchasePrice||0);
        a.stock=before+qty; a.purchasePrice=Number(line.purchasePrice||oldPrice); a.updatedAt=new Date().toISOString();
        const movement={at:a.updatedAt,articleId:a.id,ean:a.ean||"",product:a.product||"",baseCode:a.baseCode||"",size:a.size||"",direction:"in",quantity:qty,delta:qty,before,after:a.stock,reason:"invoice",invoiceRef,user:"Dunja Eingangsrechnung",purchasePrice:a.purchasePrice};
        await appendJsonl(movementsFile,movement); if(a.purchasePrice!==oldPrice)await appendJsonl(priceHistoryFile,{at:a.updatedAt,articleId:a.id,oldPurchasePrice:oldPrice,newPurchasePrice:a.purchasePrice,invoiceRef,source:"LG-Rechnung"});
        results.push({articleId:a.id,stockCode:line.stockCode,before,after:a.stock,quantity:qty,purchasePrice:a.purchasePrice});
      }
      await writeJson(articlesFile,articles);
      const purchases=await readJson(purchasesFile,[]); const purchase={invoiceRef,invoiceDate,netAmount:Number(netAmount.toFixed(2)),source:"incoming-capture",createdAt:new Date().toISOString()};
      const pi=purchases.findIndex(x=>String(x.invoiceRef)===invoiceRef); if(pi>=0)purchases[pi]={...purchases[pi],...purchase};else purchases.push(purchase); await writeJson(purchasesFile,purchases);
      sync[invoiceRef]={at:new Date().toISOString(),invoiceDate,netAmount:Number(netAmount.toFixed(2)),paintLines:results.length}; await writeJson(syncFile,sync);
      res.json({ok:true,invoiceRef,paintLines:results.length,results,netAmount:Number(netAmount.toFixed(2))});
    }catch(e){res.status(500).json({ok:false,error:String(e?.message||e)});}
  });
}

module.exports={registerPaintInventory};

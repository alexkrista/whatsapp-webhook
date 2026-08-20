"use strict";

// Offizielle Little-Greene-Bestellliste = Artikelwahrheit.
// Excel dient nur als strukturierte Importquelle; laufender Bestand bleibt in KRISTINE.
// Inventur zeigt bewusst nur LG BASES + COLOURANTS. Sample Pots / Marketing werden
// mit eingelesen, aber nicht inventarisiert und koennen spaeter als Bestellzusatz genutzt werden.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
let XLSX = null;
try { XLSX = require("xlsx"); } catch {}

const BASE_NAMES = {
  H: "Hi White", HI: "Hi White",
  M: "Medium", D: "Deep",
  XD: "Extra Deep", X: "Extra Deep",
  T: "Transparent", Y: "Yellow",
  W: "White ASP", P: "Pastel",
  BC: "Blue BC", TC: "Blue TC",
};

function registerPaintOrderformFix(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const catalogFile = path.join(root, "lg-order-catalog.json");

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
  const norm = v => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const baseName = code => BASE_NAMES[clean(code,20).toUpperCase()] || clean(code,80);
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
  const sizeMl = value => {
    const m=sizeNorm(value).match(/^([0-9.]+)\s*L$/i); return m?Number(m[1])*1000:0;
  };
  const safeId = value => clean(value,220).replace(/[^A-Za-z0-9_-]+/g,"_").replace(/^_+|_+$/g,"");
  const articleKey = a => `${norm(a.product)}|${norm(a.baseCode||a.baseName)}|${sizeNorm(a.size)}`;

  async function ensureRoot(){ await fsp.mkdir(root,{recursive:true}); }
  async function readJson(file,fallback){ try{return JSON.parse(await fsp.readFile(file,"utf8"));}catch{return fallback;} }
  async function writeJson(file,value){ await ensureRoot(); const tmp=`${file}.tmp`; await fsp.writeFile(tmp,JSON.stringify(value,null,2),"utf8"); await fsp.rename(tmp,file); }

  function rowsOf(workbook, name) {
    const sheet = workbook.Sheets[name];
    return sheet ? XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:""}) : [];
  }

  function parseOfficialOrderForm(buffer) {
    if (!XLSX) throw new Error("xlsx-Modul fehlt");
    const workbook=XLSX.read(buffer,{type:"buffer",cellDates:true});
    if (!workbook.Sheets["LG BASES"] && !workbook.Sheets["COLOURANTS"]) return null;

    const articles=[];
    const counts={bases:0,colourants:0,samplePots:0,marketing:0};
    let currentProduct="", currentSize="";

    const baseRows=rowsOf(workbook,"LG BASES");
    for(let i=1;i<baseRows.length;i++){
      const row=baseRows[i]||[];
      if(clean(row[0])) currentProduct=clean(row[0],180);
      if(clean(row[1])) currentSize=sizeNorm(row[1]);
      const baseCode=clean(row[2],20).toUpperCase();
      const sku=clean(row[3],100);
      if(!currentProduct||!currentSize||!baseCode||!sku)continue;
      articles.push({
        id:`LG-${safeId(sku)}`, manufacturer:"Little Greene", category:"base", inventory:true, orderable:true, orderSection:"bases",
        product:currentProduct, baseCode, baseName:baseName(baseCode), size:currentSize, sizeMl:sizeMl(currentSize),
        ean:"", stockCode:sku, stock:0, targetStock:0, minimumStock:0, purchasePrice:num(row[5],0), salePrice:0,
        active:true, source:"Official LG Order Form / LG BASES", updatedAt:new Date().toISOString(),
      }); counts.bases++;
    }

    const colourRows=rowsOf(workbook,"COLOURANTS");
    for(let i=1;i<colourRows.length;i++){
      const row=colourRows[i]||[];
      const code=clean(row[0],20).toUpperCase(), size=sizeNorm(row[1]), colour=clean(row[2],100), sku=clean(row[3],100);
      if(!code||!size||!colour||!sku||/^TOTAL/i.test(sku))continue;
      articles.push({
        id:`LG-${safeId(sku)}`, manufacturer:"Little Greene", category:"colourant", inventory:true, orderable:true, orderSection:"colourants",
        product:"Colourants", baseCode:code, baseName:`${code} · ${colour}`, size, sizeMl:sizeMl(size),
        ean:"", stockCode:sku, stock:0, targetStock:0, minimumStock:0, purchasePrice:num(row[5],0), salePrice:0,
        active:true, source:"Official LG Order Form / COLOURANTS", updatedAt:new Date().toISOString(),
      }); counts.colourants++;
    }

    const sampleRows=rowsOf(workbook,"LG SAMPLE POTS");
    for(let i=1;i<sampleRows.length;i++){
      const row=sampleRows[i]||[];
      const number=clean(row[0],30), label=clean(row[1],180), sku=clean(row[2],100);
      if(!label||!sku)continue;
      articles.push({
        id:`LG-${safeId(sku)}`, manufacturer:"Little Greene", category:"sample-pot", inventory:false, orderable:true, orderSection:"sample-pots",
        product:"Sample Pots", baseCode:"", baseName:label, size:"Sample Pot", sizeMl:0, orderNumber:number,
        ean:"", stockCode:sku, stock:0, targetStock:0, minimumStock:0, purchasePrice:num(row[4],0), salePrice:0,
        active:true, source:"Official LG Order Form / LG SAMPLE POTS", updatedAt:new Date().toISOString(),
      }); counts.samplePots++;
    }

    const marketingRows=rowsOf(workbook,"LG MARKETING");
    for(let i=1;i<marketingRows.length;i++){
      const row=marketingRows[i]||[];
      const label=clean(row[1],180), sku=clean(row[2],100);
      if(!label)continue;
      const stable=sku||`MARKETING-${safeId(label)}`;
      articles.push({
        id:`LG-${safeId(stable)}`, manufacturer:"Little Greene", category:"marketing", inventory:false, orderable:true, orderSection:"marketing",
        product:"Marketing", baseCode:"", baseName:label, size:"", sizeMl:0,
        ean:"", stockCode:sku, stock:0, targetStock:0, minimumStock:0, purchasePrice:num(row[4],0), salePrice:0,
        active:true, source:"Official LG Order Form / LG MARKETING", updatedAt:new Date().toISOString(),
      }); counts.marketing++;
    }

    return {articles,counts,sourceSheets:workbook.SheetNames};
  }

  function mergeWithExisting(parsed, previous) {
    const bySku=new Map(previous.filter(a=>clean(a.stockCode)).map(a=>[clean(a.stockCode).toUpperCase(),a]));
    const byKey=new Map(previous.map(a=>[articleKey(a),a]));
    return parsed.articles.map(a=>{
      const old=bySku.get(clean(a.stockCode).toUpperCase())||byKey.get(articleKey(a));
      if(!old)return a;
      return {
        ...a,
        ean:clean(old.ean)||a.ean,
        stock:Number.isFinite(Number(old.stock))?Number(old.stock):a.stock,
        targetStock:Number.isFinite(Number(old.targetStock))?Number(old.targetStock):Number(old.minimumStock||a.targetStock||0),
        minimumStock:Number.isFinite(Number(old.minimumStock))?Number(old.minimumStock):Number(old.targetStock||a.minimumStock||0),
        salePrice:Number(old.salePrice||a.salePrice||0),
        createdAt:old.createdAt||a.createdAt,
      };
    });
  }

  function inferInventory(a){
    if(a?.inventory===false)return false;
    const c=clean(a?.category).toLowerCase();
    if(c)return c==="base"||c==="colourant";
    const sku=clean(a?.stockCode).toUpperCase();
    if(/^020606/.test(sku)||/^0299/.test(sku))return false;
    return !!clean(a?.product)&&!!clean(a?.size);
  }

  // First route wins: official order form is handled here; legacy workbook falls through to paint-lab.js.
  app.post("/admin/api/paint/import-excel", async(req,res,next)=>{
    if(!requireAdmin(req,res))return;
    try{
      const base64=clean(req.body?.base64,100_000_000).replace(/^data:.*?;base64,/,"");
      if(!base64)return next();
      const parsed=parseOfficialOrderForm(Buffer.from(base64,"base64"));
      if(!parsed)return next();
      const previous=await readJson(articlesFile,[]);
      const merged=mergeWithExisting(parsed,previous);
      await Promise.all([
        writeJson(articlesFile,merged),
        writeJson(catalogFile,{importedAt:new Date().toISOString(),counts:parsed.counts,articles:merged.map(a=>({id:a.id,category:a.category,product:a.product,baseCode:a.baseCode,baseName:a.baseName,size:a.size,stockCode:a.stockCode,purchasePrice:a.purchasePrice,orderNumber:a.orderNumber||""}))}),
      ]);
      return res.json({ok:true,officialOrderForm:true,articles:merged.length,fbAliases:"unchanged",counts:parsed.counts});
    }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
  });

  // Inventur = nur das, was Alexander wirklich zaehlt: Bases + Colourants.
  app.get("/admin/api/paint/inventory", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const rows=await readJson(articlesFile,[]);
    const items=rows.filter(a=>a&&a.active!==false&&inferInventory(a)).map(a=>{
      const target=Number(a.targetStock??a.minimumStock??0), minimum=Number(a.minimumStock??a.targetStock??0), stock=Number(a.stock||0);
      return {id:a.id||"",category:a.category||"base",product:a.product||"",baseName:a.baseName||a.baseCode||"",baseCode:a.baseCode||"",size:sizeNorm(a.size),ean:a.ean||"",stockCode:a.stockCode||"",purchasePrice:Number(a.purchasePrice||0),targetStock:target,minimumStock:minimum,stock,difference:target-stock};
    });
    res.json({ok:true,items,count:items.length,scope:"LG BASES + COLOURANTS"});
  });

  app.get("/admin/api/paint/order-catalog", async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const rows=await readJson(articlesFile,[]);
    const section=clean(req.query.section,30).toLowerCase();
    const items=rows.filter(a=>a&&a.active!==false&&a.orderable!==false&&(!section||clean(a.orderSection,30).toLowerCase()===section));
    res.json({ok:true,items});
  });
}

module.exports={registerPaintOrderformFix};

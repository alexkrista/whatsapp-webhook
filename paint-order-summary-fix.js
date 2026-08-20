"use strict";

// Bestell-Entwurf vor paint-commercial.js registrieren.
// null orderQuantityOverride = KRISTINE-Vorschlag, 0 = bewusst nicht bestellen, >0 = manuell.

const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const LG_ORDER_EMAIL = "export.orders@thelittlegreene.com";
const LG_ACCOUNT_CODE = "FAR207";

function registerPaintOrderSummaryFix(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const purchasesFile = path.join(root, "lg-purchases.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const priceListMetaFile = path.join(root, "lg-pricelist.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }
  const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
  const nullableNonNegative = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, n) : null;
  };
  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
  async function readJsonl(file) { try { return (await fsp.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } }

  function fiscalYearInfo(value = new Date()) {
    const d = value instanceof Date ? value : new Date(String(value || ""));
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear(), m = d.getMonth() + 1, startYear = m >= 11 ? y : y - 1;
    return { startYear, endYear:startYear+1, key:`${startYear}-${startYear+1}`, label:`${startYear}/${String(startYear+1).slice(-2)}`, start:`${startYear}-11-01`, end:`${startYear+1}-10-31` };
  }

  function suggestion(a) {
    const category = clean(a.category).toLowerCase();
    if (category === "sample-pot" || category === "marketing") return 0;
    const stock = Math.max(0, Number(a.stock || 0));
    const minimum = Math.max(0, Number(a.minimumStock || 0));
    const target = Math.max(minimum, Number(a.targetStock ?? minimum) || 0);
    return stock < minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function effectiveQuantity(a) {
    const override = nullableNonNegative(a.orderQuantityOverride);
    return override === null ? suggestion(a) : override;
  }

  async function openOrderSummary() {
    const articles = await readJson(articlesFile, []);
    const items = articles
      .filter(a => a && a.active !== false && a.orderable !== false && String(a.manufacturer || "Little Greene").toLowerCase().includes("little greene"))
      .map(a => {
        const quantity = effectiveQuantity(a);
        const price = Number(a.purchasePrice || 0);
        return {
          articleId:a.id||"", ean:a.ean||"", stockCode:a.stockCode||"", product:a.product||"",
          baseCode:a.baseCode||"", baseName:a.baseName||a.baseCode||"", size:a.size||"", category:a.category||"",
          stock:Number(a.stock||0), minimumStock:Number(a.minimumStock||0), targetStock:Number(a.targetStock||0),
          suggestedQuantity:suggestion(a), manualQuantity:nullableNonNegative(a.orderQuantityOverride), quantity,
          purchasePrice:price, lineTotal:Number((quantity*price).toFixed(2)), orderIndex:Number.isFinite(Number(a.orderIndex))?Number(a.orderIndex):999999,
        };
      })
      .filter(x => x.quantity > 0)
      .sort((a,b)=>a.orderIndex-b.orderIndex || String(a.product).localeCompare(String(b.product),"de"));
    const total = Number(items.reduce((s,x)=>s+x.lineTotal,0).toFixed(2));
    return { items, total, count:items.reduce((s,x)=>s+Number(x.quantity||0),0) };
  }

  async function turnoverSummary() {
    const purchases = await readJson(purchasesFile, []), byYear = new Map();
    for (const row of purchases) {
      const fy=fiscalYearInfo(row.invoiceDate||row.date||row.createdAt);if(!fy)continue;const amount=Number(row.netAmount||0);
      if(!byYear.has(fy.key))byYear.set(fy.key,{...fy,netAmount:0,invoices:0});const g=byYear.get(fy.key);g.netAmount+=amount;g.invoices+=1;
    }
    if(!purchases.length){const movements=await readJsonl(movementsFile);for(const row of movements){if(String(row.direction)!=="in"||String(row.reason)!=="invoice")continue;const fy=fiscalYearInfo(row.at);if(!fy)continue;const amount=Number(row.quantity||0)*Number(row.purchasePrice||0);if(!byYear.has(fy.key))byYear.set(fy.key,{...fy,netAmount:0,invoices:0,estimated:true});byYear.get(fy.key).netAmount+=amount}}
    const years=[...byYear.values()].map(x=>({...x,netAmount:Number(x.netAmount.toFixed(2))})).sort((a,b)=>b.startYear-a.startYear);const current=fiscalYearInfo(new Date()),currentRow=years.find(x=>x.key===current.key)||{...current,netAmount:0,invoices:0};return{current:currentRow,years};
  }

  async function buildOrderPdf(summary) {
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);const pageW=595.28,pageH=841.89,margin=38,rowsPerPage=31,chunks=[];
    for(let i=0;i<summary.items.length;i+=rowsPerPage)chunks.push(summary.items.slice(i,i+rowsPerPage));if(!chunks.length)chunks.push([]);
    chunks.forEach((chunk,pageIndex)=>{const page=pdf.addPage([pageW,pageH]);let y=pageH-margin;page.drawText("LITTLE GREENE · BESTELLUNG",{x:margin,y,size:16,font:bold,color:rgb(.12,.28,.2)});y-=24;page.drawText(`Kundenkonto: ${LG_ACCOUNT_CODE} · Farben Krista GmbH & Co KG · ${new Date().toLocaleDateString("de-AT")}`,{x:margin,y,size:9,font});y-=20;
      const cols=[{t:"Stk",x:margin},{t:"SKU",x:margin+34},{t:"Produkt / Artikel",x:margin+118},{t:"Gebinde",x:margin+330},{t:"Basis",x:margin+392},{t:"Preis",x:margin+457},{t:"Summe",x:margin+505}];cols.forEach(c=>page.drawText(c.t,{x:c.x,y,size:8.5,font:bold}));y-=12;page.drawLine({start:{x:margin,y},end:{x:pageW-margin,y},thickness:.7,color:rgb(.75,.75,.72)});y-=14;
      for(const item of chunk){page.drawText(String(item.quantity),{x:margin,y,size:8.2,font});page.drawText(String(item.stockCode||"").slice(0,15),{x:margin+34,y,size:8,font});page.drawText(String(item.product||item.baseName||"").slice(0,34),{x:margin+118,y,size:8,font});page.drawText(String(item.size||"").slice(0,10),{x:margin+330,y,size:8,font});page.drawText(String(item.baseName||item.baseCode||"").slice(0,13),{x:margin+392,y,size:8,font});page.drawText(`€ ${Number(item.purchasePrice||0).toFixed(2)}`,{x:margin+452,y,size:8,font});page.drawText(`€ ${Number(item.lineTotal||0).toFixed(2)}`,{x:margin+500,y,size:8,font});y-=20}
      if(pageIndex===chunks.length-1){y-=8;page.drawLine({start:{x:margin+390,y:y+10},end:{x:pageW-margin,y:y+10},thickness:1,color:rgb(.25,.25,.25)});page.drawText(`Offene Bestellung netto: € ${summary.total.toFixed(2)}`,{x:margin+325,y:y-8,size:11,font:bold})}page.drawText(`Seite ${pageIndex+1}/${chunks.length}`,{x:pageW-margin-55,y:22,size:8,font});
    });
    return Buffer.from(await pdf.save());
  }

  function makeMailer(){const host=process.env.SMTP_HOST||"",port=Number(process.env.SMTP_PORT||587),user=process.env.SMTP_USER||"",pass=process.env.SMTP_PASS||"";if(!host||!user||!pass)throw new Error("SMTP ist nicht vollständig konfiguriert");return nodemailer.createTransport({host,port,secure:false,auth:{user,pass}})}

  app.get("/admin/api/paint/lg-commercial", async(req,res)=>{if(!requireAdmin(req,res))return;const[order,turnover,priceList]=await Promise.all([openOrderSummary(),turnoverSummary(),readJson(priceListMetaFile,null)]);res.json({ok:true,order,turnover,priceList,orderEmail:LG_ORDER_EMAIL,accountCode:LG_ACCOUNT_CODE,draft:true})});
  app.get("/admin/api/paint/lg-order/pdf", async(req,res)=>{if(!requireAdmin(req,res))return;const summary=await openOrderSummary(),pdf=await buildOrderPdf(summary);res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`inline; filename=\"LittleGreene_Bestellung_${new Date().toISOString().slice(0,10)}.pdf\"`);res.send(pdf)});
  app.post("/admin/api/paint/lg-order/email", async(req,res)=>{if(!requireAdmin(req,res))return;try{const summary=await openOrderSummary();if(!summary.items.length)return res.status(409).json({ok:false,error:"Die offene Bestellung ist leer"});const pdf=await buildOrderPdf(summary),mailer=makeMailer(),from=process.env.MAIL_FROM||process.env.SMTP_USER,subject=`Order ${LG_ACCOUNT_CODE} · Farben Krista · € ${summary.total.toFixed(2)}`,text=`Dear Little Greene Export Team,\n\nplease find attached our current order for account ${LG_ACCOUNT_CODE}.\n\nNet order value: € ${summary.total.toFixed(2)}\n\nKind regards\nFarben Krista GmbH & Co KG`,info=await mailer.sendMail({from,to:LG_ORDER_EMAIL,subject,text,attachments:[{filename:`LittleGreene_Order_${new Date().toISOString().slice(0,10)}.pdf`,content:pdf,contentType:"application/pdf"}]});res.json({ok:true,to:LG_ORDER_EMAIL,total:summary.total,messageId:info.messageId})}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});
}

module.exports={registerPaintOrderSummaryFix};

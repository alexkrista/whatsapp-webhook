"use strict";
// Private, read-only mirror of the LG incoming invoice metadata from THE BRAIN.
// Invoice selection is NOT a payment or stock posting.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {withOrderLock} = require("./paint-order-lock");

const round = value => Math.round(Number(value) * 1000) / 1000;
const cents = value => Math.round(Number(value) * 100);
const ref = value => String(value || "").trim().toUpperCase();
const validRef = value => /^[A-Z0-9][A-Z0-9._/-]{2,99}$/.test(value);
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const time = Date.parse(value + "T12:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
};

function todayVienna(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(now);
}
function cutoffVienna(now = new Date()) {
  const day = new Date(todayVienna(now) + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() - 21);
  return day.toISOString().slice(0,10);
}
function normalizeInvoice(raw) {
  const invoiceRef = ref(raw?.invoiceRef), invoiceDate = String(raw?.invoiceDate || "").slice(0,10);
  const netAmount = Number(raw?.netAmount);
  if (!validRef(invoiceRef) || !validDate(invoiceDate) || !Number.isFinite(netAmount) || netAmount <= 0 || netAmount > 1000000)
    throw Error("Ungültige Little-Greene-Rechnungsdaten.");
  const supplied = Array.isArray(raw?.lines) ? raw.lines : [];
  if (supplied.length > 250) throw Error("Zu viele Rechnungspositionen.");
  const bySku = new Map();
  for (const line of supplied) {
    const sku = ref(line?.sku).replace(/\s+/g,"");
    const quantity = round(line?.quantity), unitPrice = Number(line?.unitPrice);
    const total = Number(line?.net ?? (quantity * unitPrice));
    if (!/^[A-Z0-9]{6,30}$/.test(sku) || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(total) ||
        Math.abs(cents(total) - cents(quantity * unitPrice)) > 1) throw Error("Ungültige LG-Rechnungsposition.");
    const old = bySku.get(sku);
    if (old && Math.abs(old.unitPrice - unitPrice) > 0.005) throw Error("Unterschiedliche Preise zur gleichen SKU.");
    bySku.set(sku, {
      sku,quantity:round((old?.quantity || 0) + quantity),unitPrice:Number(unitPrice.toFixed(2)),
      net:Number(((old?.net || 0) + total).toFixed(2))
    });
  }
  const lines = [...bySku.values()];
  const linesTotal = lines.reduce((sum,line) => sum + cents(line.net), 0);
  const issue = !lines.length ? "Keine Rechnungspositionen erkannt." :
    Math.abs(linesTotal - cents(netAmount)) > 2 ? "Positionssumme stimmt nicht mit dem Rechnungsbetrag überein." : "";
  return {
    invoiceRef,invoiceDate,netAmount:Number(netAmount.toFixed(2)),
    sourceInvoiceId:Number.isSafeInteger(Number(raw?.sourceInvoiceId))?Number(raw.sourceInvoiceId):null,
    paymentStatus:String(raw?.paymentStatus || "").slice(0,50),
    lines,issue
  };
}
function createLgCandidateStore(dataDir) {
  const root=path.join(dataDir,"_kristine","paint");
  const file=path.join(root,"lg-invoice-candidates.json");
  async function read() {
    try {
      const data=JSON.parse(await fs.readFile(file,"utf8"));
      return Array.isArray(data.invoices)?data:{version:1,syncedAt:null,invoices:[]};
    } catch(error) { if(error.code==="ENOENT")return {version:1,syncedAt:null,invoices:[]}; throw error; }
  }
  async function replace(input) {
    if (!Array.isArray(input) || input.length > 400) throw Error("Ungültige Kandidatenliste.");
    const invoices=input.map(normalizeInvoice);
    if(new Set(invoices.map(row=>row.invoiceRef)).size!==invoices.length) throw Error("Rechnungsnummer doppelt.");
    const data={version:1,syncedAt:new Date().toISOString(),invoices};
    return withOrderLock(root,async()=>{
      await fs.mkdir(root,{recursive:true});
      const tmp=file+"."+crypto.randomUUID()+".tmp";
      await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600});
      await fs.rename(tmp,file);
      return {count:invoices.length,syncedAt:data.syncedAt};
    });
  }
  async function find(invoiceRef) {
    const data=await read();
    return data.invoices.find(row=>row.invoiceRef===ref(invoiceRef)) || null;
  }
  return {read,replace,find};
}
function requireLgCandidatesSync(req,res) {
  const wanted=String(process.env.KRISTINE_LG_CANDIDATES_TOKEN || "");
  const supplied=String(req.headers["x-krista-lg-candidates-token"] || "");
  if(!wanted || !supplied || Buffer.byteLength(wanted)!==Buffer.byteLength(supplied) ||
    !crypto.timingSafeEqual(Buffer.from(wanted),Buffer.from(supplied))) {
    res.status(403).json({ok:false,error:"LG-Rechnungsabgleich nicht autorisiert."});
    return false;
  }
  return true;
}
module.exports={createLgCandidateStore,requireLgCandidatesSync,cutoffVienna,normalizeInvoice};

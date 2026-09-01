"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const STATUS = Object.freeze({
  DUPLICATE: "bereits_vorhanden", NEWER: "neue_version", OLDER: "aelter",
  NEW: "neues_produkt", UNCLEAR: "unklar",
});

function clean(value, max = 2000) { return String(value ?? "").replace(/\0/g, "").trim().slice(0, max); }
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function normalized(value) {
  return clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\b(?:gesellschaft\s+m\s+b\s+h|g\s*m\s*b\s*h|ag|kg|ltd|limited|sarl|co)\b/g, " ").replace(/\s+/g," ").trim();
}
function codes(text, prefix) {
  const pattern = prefix === "EUH" ? /\bEUH\s?\d{3}[A-Z]?\b/gi : new RegExp(`\\b${prefix}\\s?\\d{3}[A-Z]?(?:\\+${prefix}?\\d{3})*\\b`, "gi");
  return uniq((text.match(pattern) || []).map((x) => x.toUpperCase().replace(/\s/g, "")));
}
function section(text, number, next) {
  const start = new RegExp(`(?:^|\\n)\\s*(?:ABSCHNITT\\s*)?${number}(?:[.:]|\\s)`, "im").exec(text);
  if (!start) return "";
  const tail = text.slice(start.index + start[0].length);
  const end = new RegExp(`(?:^|\\n)\\s*(?:ABSCHNITT\\s*)?${next}(?:[.:]|\\s)`, "im").exec(tail);
  return clean(end ? tail.slice(0, end.index) : tail, 12000);
}
function first(text, patterns) {
  for (const pattern of patterns) { const match = pattern.exec(text); if (match?.[1]) return clean(match[1]); }
  return "";
}
function extractManufacturer(text) {
  const compact = String(text || "").replace(/\r/g, "");
  const block = section(compact, "1\\.3", "1\\.4") || compact.slice(0, 12000);
  const value = first(block, [
    /^\s*(?:Hersteller\s*\/\s*Lieferant|Hersteller|Lieferant|Firma|Unternehmen)\s*:\s*([^\n]{2,220})\s*$/im,
  ]).replace(/\s+(?:Tel\.?|Telefon|Fax|E-?Mail|Internet)\s*[:.].*$/i, "").trim();
  if (!value || /^(?:en[,\s]|der\s+das\b|des\s+sicherheitsdatenblatts?\b)/i.test(value)) return "";
  return clean(value, 300);
}
function parseDate(raw) {
  const value = clean(raw, 30); let match;
  if ((match = value.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/))) return `${match[3]}-${match[2].padStart(2,"0")}-${match[1].padStart(2,"0")}`;
  if ((match = value.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${match[1]}-${match[2]}-${match[3]}`;
  return "";
}
function deriveHazards(meta) {
  const all = new Set(meta.hStatements);
  const has = (...items) => items.some((x) => all.has(x));
  return [
    ["aetzend", has("H314","H318")], ["entzuendlich", has("H224","H225","H226","H228")],
    ["hautsensibilisierend", has("H317")], ["atemwegssensibilisierend", has("H334")],
    ["akut_toxisch", [...all].some((x) => /^H30[0-2]$|^H31[0-2]$|^H33[0-2]$/.test(x))],
    ["cmr_pruefen", [...all].some((x) => /^H3(40|41|50|51|60|61|62)$/.test(x))],
    ["umweltgefaehrlich", has("H400","H410","H411","H412","H413")],
    ["augenreizung", has("H319")], ["hautreizung", has("H315")], ["atemwegsreizung", has("H335")],
  ].filter(([, yes]) => yes).map(([key]) => key);
}
function extractMetadata(text, fileName = "") {
  const compact = text.replace(/\r/g, "");
  const firstPage = compact.slice(0, 9000);
  const product = first(firstPage, [/(?:Produktname|Handelsname|Bezeichnung des Gemischs|Product name)\s*[:\-]?\s*([^\n]{2,180})/i]) || clean(path.basename(fileName, path.extname(fileName)).replace(/\b(MSDS|SDB|Sicherheitsdatenblatt|DE|Deutsch)\b/gi," ").replace(/[()_]+/g," "));
  const manufacturer = extractManufacturer(compact);
  const productCode = first(firstPage, [/(?:Produktcode|Artikelnummer|Artikel-Nr\.?|Product code)\s*[:\-]?\s*([^\n]{1,100})/i]);
  const dateRaw = first(firstPage, [/(?:Überarbeitet am|Ausgabedatum|Erstellt am|Datum der letzten Ausgabe|Revision date)\s*[:\-]?\s*([^\n]{4,40})/i]);
  const version = first(firstPage, [/(?:Version|Revision|Überarbeitung)\s*[:\-]?\s*([\w.\-]{1,30})/i]);
  const ghs = uniq((compact.match(/\bGHS\s?0[1-9]\b/gi) || []).map((x) => x.toUpperCase().replace(/\s/g,"")));
  const meta = { manufacturer, product, productCode, sdbDate: parseDate(dateRaw), version, ghs,
    signalWord: first(section(compact,2,3), [/(?:Signalwort)\s*[:\-]?\s*(Gefahr|Achtung)/i]),
    hStatements: codes(compact,"H"), euhStatements: codes(compact,"EUH"), pStatements: codes(compact,"P"),
    firstAid: section(compact,4,5), ppe: section(compact,8,9), extractionConfidence: 0 };
  const required = [meta.manufacturer, meta.product, meta.sdbDate || meta.version, meta.hStatements.length || meta.euhStatements.length];
  meta.extractionConfidence = Number((required.filter(Boolean).length / required.length).toFixed(2));
  meta.derivedHazards = deriveHazards(meta);
  return meta;
}
function versionParts(value) { return clean(value,40).match(/\d+/g)?.map(Number) || []; }
function compareVersions(a, b) {
  const av = versionParts(a.version), bv = versionParts(b.version);
  for (let i=0; i<Math.max(av.length,bv.length); i++) { if ((av[i]||0)!==(bv[i]||0)) return (av[i]||0)>(bv[i]||0)?1:-1; }
  if (a.sdbDate && b.sdbDate && a.sdbDate !== b.sdbDate) return a.sdbDate > b.sdbDate ? 1 : -1;
  return 0;
}
function matchProduct(meta, documents) {
  const code = normalized(meta.productCode), product = normalized(meta.product), maker = normalized(meta.manufacturer);
  return documents.filter((doc) => {
    if (code && normalized(doc.metadata?.productCode) === code) return true;
    const sameProduct = product && normalized(doc.metadata?.product) === product;
    return sameProduct && (!maker || !doc.metadata?.manufacturer || normalized(doc.metadata.manufacturer) === maker);
  }).sort((a,b) => compareVersions(b.metadata || {}, a.metadata || {}));
}
function diffSafety(current, incoming) {
  const fields = ["ghs","hStatements","euhStatements","pStatements","derivedHazards"];
  const changes = [];
  for (const field of fields) {
    const before = new Set(current?.[field] || []), after = new Set(incoming?.[field] || []);
    const added = [...after].filter((x)=>!before.has(x)), removed = [...before].filter((x)=>!after.has(x));
    if (added.length || removed.length) changes.push({ field, added, removed, safetyRelevant: true });
  }
  for (const field of ["firstAid","ppe","signalWord"]) if (clean(current?.[field]) !== clean(incoming?.[field])) changes.push({field, changed:true, safetyRelevant:true});
  return changes;
}
function classify(hash, meta, documents) {
  const duplicate = documents.find((x)=>x.sha256 === hash);
  if (duplicate) return { status: STATUS.DUPLICATE, matchedDocument: duplicate, reasons:["SHA-256 identisch"] };
  const matches = matchProduct(meta, documents);
  if (!matches.length) return meta.product && meta.extractionConfidence >= .5
    ? {status:STATUS.NEW,reasons:["Kein passendes Produkt im Masterindex"]}
    : {status:STATUS.UNCLEAR,reasons:["Produkt oder Version nicht sicher genug erkannt"]};
  const current = matches[0], order = compareVersions(meta,current.metadata || {});
  return { status: order>0?STATUS.NEWER:order<0?STATUS.OLDER:STATUS.UNCLEAR, matchedDocument:current,
    reasons:[order>0?"Datum/Version ist neuer":order<0?"Datum/Version ist älter":"Produkt bekannt, Versionsreihenfolge unklar"],
    changes:diffSafety(current.metadata || {},meta) };
}

function registerSafetySdb(app, { dataDir, requireAdmin }) {
  const root = path.join(dataDir,"_kristine","arbeitssicherheit");
  const indexFile = path.join(root,"sdb-masterindex.json");
  async function readIndex(){ try { const x=JSON.parse(await fs.readFile(indexFile,"utf8")); return Array.isArray(x.documents)?x:{documents:[]}; } catch{return {schemaVersion:1,sourceOfTruth:"N:\\SdB",documents:[]};} }
  async function writeIndex(index){ await fs.mkdir(root,{recursive:true}); const tmp=`${indexFile}.tmp`; await fs.writeFile(tmp,JSON.stringify(index,null,2)); await fs.rename(tmp,indexFile); }
  const guard=(req,res)=>!requireAdmin||requireAdmin(req,res);
  app.get("/admin/api/safety/sdb",async(req,res)=>{if(!guard(req,res))return; const index=await readIndex(); res.json({ok:true,...index});});
  app.post("/admin/api/safety/sdb/analyze",async(req,res)=>{if(!guard(req,res))return; try{
    const name=clean(req.body?.name,180), data=clean(req.body?.data,40_000_000);
    if(!/\.pdf$/i.test(name)||!data) return res.status(400).json({ok:false,error:"Bitte eine PDF-Datei auswählen."});
    const base64=data.includes(",")?data.slice(data.indexOf(",")+1):data; const buffer=Buffer.from(base64,"base64");
    if(!buffer.subarray(0,5).equals(Buffer.from("%PDF-"))) return res.status(400).json({ok:false,error:"Die Datei ist keine gültige PDF."});
    const sha256=crypto.createHash("sha256").update(buffer).digest("hex"); const parser=new PDFParse({data:buffer});
    let parsed; try { parsed=await parser.getText(); } finally { await parser.destroy(); }
    const metadata=extractMetadata(parsed.text,name);
    const index=await readIndex(), result=classify(sha256,metadata,index.documents);
    const review={id:crypto.randomUUID(),name,sha256,size:buffer.length,analyzedAt:new Date().toISOString(),metadata,...result,reviewStatus:"pruefung_erforderlich",autoApproved:false};
    res.json({ok:true,review});
  }catch(error){res.status(422).json({ok:false,error:`PDF konnte nicht ausgewertet werden: ${clean(error.message,300)}`});}});
  app.post("/admin/api/safety/sdb/reviews",async(req,res)=>{if(!guard(req,res))return; const review=req.body?.review;
    if(!review?.sha256||!review?.metadata) return res.status(400).json({ok:false,error:"Analyse fehlt."});
    const index=await readIndex(); const existing=index.documents.find((x)=>x.sha256===review.sha256); if(existing)return res.json({ok:true,document:existing,duplicate:true});
    const document={id:review.id||crypto.randomUUID(),sha256:clean(review.sha256,64),fileName:clean(review.name,180),size:Number(review.size)||0,metadata:review.metadata,
      detectionStatus:review.status,reviewStatus:"pruefung_erforderlich",autoApproved:false,source:{type:"admin_upload",sourceOfTruth:"N:\\SdB",physicalPath:null},createdAt:new Date().toISOString()};
    index.documents.unshift(document); index.updatedAt=new Date().toISOString(); await writeIndex(index); res.json({ok:true,document});
  });
  app.post("/admin/api/safety/sdb/:id/review",async(req,res)=>{if(!guard(req,res))return;
    const decision=clean(req.body?.decision,40),reviewer=clean(req.body?.reviewer,120),note=clean(req.body?.note,2000);
    if(!["freigegeben","korrektur_erforderlich"].includes(decision))return res.status(400).json({ok:false,error:"Ungültige Prüfentscheidung."});
    if(!reviewer)return res.status(400).json({ok:false,error:"Prüfer fehlt."});
    if(decision==="korrektur_erforderlich"&&!note)return res.status(400).json({ok:false,error:"Bitte die notwendige Korrektur beschreiben."});
    const index=await readIndex(),document=index.documents.find(x=>String(x.id)===String(req.params.id));
    if(!document)return res.status(404).json({ok:false,error:"Dokument nicht gefunden."});
    const documentType=clean(document.documentType||document.metadata?.documentType,80);
    if(decision==="freigegeben"&&documentType!=="sdb")return res.status(400).json({ok:false,error:"Nur Sicherheitsdatenblätter können fachlich freigegeben werden."});
    const input=req.body?.metadata&&typeof req.body.metadata==="object"?req.body.metadata:{};
    const list=name=>uniq((Array.isArray(input[name])?input[name]:String(input[name]||"").split(/[,;\n]+/)).map(x=>clean(x,80)));
    document.metadata={...(document.metadata||{}),manufacturer:clean(input.manufacturer??document.metadata?.manufacturer,300),product:clean(input.product??document.metadata?.product,300),productCode:clean(input.productCode??document.metadata?.productCode,120),sdbDate:clean(input.sdbDate??document.metadata?.sdbDate,30),version:clean(input.version??document.metadata?.version,60),signalWord:clean(input.signalWord??document.metadata?.signalWord,30),ghs:list("ghs"),hStatements:list("hStatements"),euhStatements:list("euhStatements"),pStatements:list("pStatements"),firstAid:clean(input.firstAid??document.metadata?.firstAid,12000),ppe:clean(input.ppe??document.metadata?.ppe,12000)};
    const at=new Date().toISOString();document.reviewStatus=decision;document.autoApproved=false;document.review={decision,reviewer,note,at};document.reviewHistory=Array.isArray(document.reviewHistory)?document.reviewHistory:[];document.reviewHistory.unshift({decision,reviewer,note,at});document.reviewHistory=document.reviewHistory.slice(0,100);index.updatedAt=at;await writeIndex(index);res.json({ok:true,document});
  });
  app.post("/agent/api/safety/sdb/sync",async(req,res)=>{ const token=clean(req.headers["x-kristine-agent-token"],500);
    const expected=String(process.env.SDB_AGENT_TOKEN||"");
    const authorized=token.length===expected.length&&expected.length>=24&&crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected));
    if(!authorized)return res.status(401).json({ok:false,error:"Agent nicht autorisiert"});
    const rows=Array.isArray(req.body?.documents)?req.body.documents:[]; const index=await readIndex(); let accepted=0;
    for(const row of rows.slice(0,2000)){if(!/^[a-f0-9]{64}$/i.test(row.sha256||"")||!clean(row.relativePath))continue;
      const current=index.documents.find((x)=>x.sha256===row.sha256); if(current){current.lastSeenAt=new Date().toISOString();if(row.metadata&&typeof row.metadata==="object"){if(current.reviewStatus==="freigegeben"){current.latestAgentMetadata=row.metadata;current.reanalysisPending=true;}else{current.metadata=row.metadata;current.documentType=clean(row.metadata.documentType,80)||"unklar";current.reviewStatus=current.documentType==="sdb"?"pruefung_erforderlich":"nicht_sdb";}}continue;}
      const documentType=clean(row.metadata?.documentType,80)||"unklar";index.documents.unshift({id:crypto.randomUUID(),sha256:row.sha256.toLowerCase(),fileName:path.basename(clean(row.relativePath,1000)),size:Number(row.size)||0,modifiedAt:clean(row.modifiedAt,50),metadata:row.metadata||{},documentType,detectionStatus:"unklar",reviewStatus:documentType==="sdb"?"pruefung_erforderlich":"nicht_sdb",autoApproved:false,source:{type:"n_drive_agent",sourceOfTruth:"N:\\SdB",relativePath:clean(row.relativePath,1000)},createdAt:new Date().toISOString()}); accepted++;
    } index.updatedAt=new Date().toISOString(); await writeIndex(index); res.json({ok:true,accepted,total:index.documents.length});
  });
  console.log("✅ KRISTINE Arbeitssicherheit · SDB-Eingang registriert");
}

module.exports={STATUS,extractMetadata,extractManufacturer,compareVersions,diffSafety,classify,registerSafetySdb};

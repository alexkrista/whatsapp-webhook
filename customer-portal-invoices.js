"use strict";

const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const D = require("./public/ui/baustellen-data");
const clean = value => String(value ?? "").trim();
const identity = value => clean(value).toLowerCase();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readCustomerInvoices(dataDir, jobs) {
  const refs = D.projects({ kind:"collection", collectionMemberJobIds:jobs.map(job=>job.jobId) }, jobs);
  const latest = new Map(), unavailable = [], stands = [];
  const sources = await D.mapLimit(refs, 4, async ref => {
    const snapshot = JSON.parse(await fs.readFile(path.join(dataDir, "_system/ww-cache/billing", ref.projectNumber+".json"), "utf8"));
    if (snapshot.projectNumber !== ref.projectNumber || snapshot.data?.projectNumber !== ref.projectNumber || !Array.isArray(snapshot.data?.invoices) || typeof snapshot.data.found !== "boolean") throw Error("Invalid invoice source");
    if (!snapshot.data.found && snapshot.data.invoices.length) throw Error("Unresolved invoice source");
    return { ref, snapshot };
  });
  for (const [index, result] of sources.entries()) {
    if (result.status !== "fulfilled") { unavailable.push({ jobId:refs[index].jobId }); continue; }
    const { ref, snapshot } = result.value;
    if (snapshot.syncedAt) stands.push(snapshot.syncedAt);
    for (const row of snapshot.data.invoices) {
      if (row?.status !== "issued") continue;
      if (row.projectNumber && String(row.projectNumber) !== ref.projectNumber) { unavailable.push({ jobId:ref.jobId }); continue; }
      const key = `${ref.jobId}|${row.source || ""}|${row.invoiceNumber || row.sourceId || row.id}`;
      const previous = latest.get(key);
      const stamp = item => String(item.changedAt || item.updatedAt || item.issueDate || "");
      if (previous && (stamp(previous.raw) > stamp(row) || stamp(previous.raw) === stamp(row) && Number(previous.raw.id) >= Number(row.id))) continue;
      const id = hash(JSON.stringify([ref.projectNumber,row.sourceId,row.id,row.invoiceNumber,row.issueDate,row.net,row.gross])).slice(0,32);
      latest.set(key, { id, jobId:ref.jobId, projectNumber:ref.projectNumber, projectIndex:Number(snapshot.data.projectIndex || ref.projectIndex), raw:row });
    }
  }
  return { entries:[...latest.values()], complete:!unavailable.length, unavailable, syncedAt:stands.sort()[0] || null };
}

function invoiceView(entry, canFetchPdf) {
  const row = entry.raw;
  return { id:entry.id, jobId:entry.jobId, number:clean(row.invoiceNumber), date:clean(row.issueDate).slice(0,10),
    kind:["TR","SR","RE","GS","ST"].includes(row.kind)?row.kind:"RE", net:D.num(row.net), gross:D.num(row.gross),
    url:canFetchPdf && entry.projectIndex > 0 ? `/kundenportal/api/invoice/${encodeURIComponent(entry.jobId)}/${entry.id}` : null };
}

function createInvoicePdfReader({ dataDir, baseUrl, createPermit, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  async function request(route, params) {
    const permit = createPermit(route);
    if (!permit) throw fail(503,"Die Verbindung zum Rechnungsarchiv ist noch nicht eingerichtet.");
    const url = new URL(route, base); for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
    let response;
    try { response = await fetchImpl(url,{headers:{"X-Krista-Brain-Permit":permit},redirect:"error",signal:AbortSignal.timeout(20000)}); }
    catch { throw fail(503,"Das Original-PDF ist gerade nicht erreichbar. Bitte später erneut versuchen."); }
    if (!response.ok) throw fail(response.status===404?404:503,"Das Original-PDF ist gerade nicht verfügbar. Bitte Farben Krista informieren.");
    return response;
  }
  return async entry => {
    const folder = path.join(dataDir,entry.jobId,"_customer-invoices"), file = path.join(folder,entry.id+".pdf");
    try { const stored=await fs.readFile(file); if(stored.subarray(0,5).toString()==="%PDF-")return stored; }
    catch(error){if(error.code!=="ENOENT")throw error;}
    if (!(entry.projectIndex>0)) throw fail(404,"Das Original-PDF wurde noch nicht übernommen.");
    const response=await request("/project/documents",{projectIndex:entry.projectIndex}), catalog=await response.json();
    if (!catalog.ok || String(catalog.project?.projectNumber)!==entry.projectNumber || Number(catalog.project?.projectIndex)!==entry.projectIndex) throw fail(404,"Das Original-PDF konnte dieser Akte nicht eindeutig zugeordnet werden.");
    const invoiceNumber=identity(entry.raw.invoiceNumber), sourceId=identity(entry.raw.sourceId);
    const candidates=(Array.isArray(catalog.documents)?catalog.documents:[]).filter(doc=>{
      if(!doc?.path||doc.pdfFound===false)return false;
      const type=String(doc.documentType||doc.dokumenttyp||"");
      if(/eingang|lieferant/i.test(type))return false;
      const ids=[doc.wwBookId,...(doc.wwBookIds||[]),...(doc.wwDocIds||[])].map(identity);
      return sourceId&&ids.includes(sourceId) || /rechnung|gutschrift|storno/i.test(type)&&invoiceNumber&&identity(doc.bookNumber)===invoiceNumber;
    });
    const unique=[...new Map(candidates.map(doc=>[doc.path,doc])).values()];
    if(unique.length!==1)throw fail(404,"Das Original-PDF ist im Archiv noch nicht eindeutig hinterlegt. Bitte Farben Krista informieren.");
    const pdf=await request("/pdf",{path:unique[0].path}),maximum=30*1024*1024;
    if(!/^application\/pdf(?:;|$)/i.test(pdf.headers.get("content-type")||"")||Number(pdf.headers.get("content-length"))>maximum)throw fail(502,"Das Archiv hat kein lesbares Rechnungs-PDF geliefert.");
    const chunks=[];let size=0;
    for await(const chunk of pdf.body){size+=chunk.length;if(size>maximum)throw fail(413,"Das Rechnungs-PDF ist zu groß.");chunks.push(chunk);}
    const body=Buffer.concat(chunks);if(body.subarray(0,5).toString()!=="%PDF-")throw fail(502,"Das Archiv hat kein lesbares Rechnungs-PDF geliefert.");
    await fs.mkdir(folder,{recursive:true});const temp=file+"."+crypto.randomUUID()+".tmp";
    try{await fs.writeFile(temp,body,{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
    return body;
  };
}

module.exports = { readCustomerInvoices, invoiceView, createInvoicePdfReader };

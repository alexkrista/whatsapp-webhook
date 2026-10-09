"use strict";
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto");
const hash=body=>crypto.createHash("sha256").update(body).digest("hex");
const sourceKinds=new Set(["TR","SR","RE","GS","ST"]);
const locks=new Map();
function validate(value){
  const v={
    project:String(value.project||""),number:String(value.number||""),
    invoiceId:String(value.invoiceId||""),kind:String(value.kind||""),
    source:String(value.source||""),date:String(value.date||""),
    digest:String(value.digest||"").toLowerCase(),
  };
  if(!/^\d{2,12}$/.test(v.project)||!/^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$/.test(v.number)||
    !/^\d{1,12}$/.test(v.invoiceId)||!sourceKinds.has(v.kind)||
    !["KRISTINE","WW"].includes(v.source)||!/^\d{4}-\d{2}-\d{2}$/.test(v.date)||
    !/^[a-f0-9]{64}$/.test(v.digest))throw Error("Ungültige Rechnungszuordnung");
  return v;
}
function locations(root,v){
  const dir=path.join(root,v.project,"_documentation");
  const stem="invoice-"+v.source+"-"+v.number+"-"+v.invoiceId;
  return {dir,pdf:path.join(dir,stem+".pdf"),meta:path.join(dir,"_issued_invoice_meta",v.source+"-"+v.invoiceId+".json")};
}
async function writeOnce(file,body){
  const tmp=file+".tmp-"+crypto.randomUUID();
  try{
    await fs.writeFile(tmp,body,{flag:"wx"});
    try{await fs.link(tmp,file);return true}
    catch(error){if(error.code==="EEXIST")return false;throw error}
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
}
async function archiveInvoice(root,input,body){
  const info=validate(input);
  if(!Buffer.isBuffer(body)||body.length<8||body.length>20*1024*1024||body.subarray(0,5).toString()!=="%PDF-"||hash(body)!==info.digest)
    throw Error("Rechnungs-PDF fehlt oder Prüfsumme ist falsch");
  const p=locations(root,info);
  const before=locks.get(p.dir)||Promise.resolve();
  const pending=before.catch(()=>{}).then(async()=>{
    const folder=await fs.stat(path.join(root,info.project)).catch(()=>null);
    if(!folder?.isDirectory())throw Error("Die Baustelle ist nicht angelegt");
    await fs.mkdir(path.dirname(p.meta),{recursive:true});
    const old=await fs.readFile(p.meta,"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return null;throw e});
    if(old&&JSON.stringify(old.info)!==JSON.stringify(info))throw Error("Abweichende Originalrechnung bereits vorhanden");
    const isNew=await writeOnce(p.pdf,body);
    if(!isNew && hash(await fs.readFile(p.pdf))!==info.digest)throw Error("Abweichendes PDF bereits vorhanden");
    if(!old)await writeOnce(p.meta,Buffer.from(JSON.stringify({info,archivedAt:new Date().toISOString()},null,2)));
    return {created:!old,project:info.project,invoiceNumber:info.number};
  });
  locks.set(p.dir,pending);
  void pending.finally(()=>{if(locks.get(p.dir)===pending)locks.delete(p.dir)}).catch(()=>{});
  return pending;
}
async function listInvoiceDocuments(root,project){
  if(!/^\d{2,12}$/.test(String(project||"")))return [];
  const dir=path.join(root,String(project),"_documentation","_issued_invoice_meta");
  const names=await fs.readdir(dir).catch(e=>{if(e.code==="ENOENT")return [];throw e});
  const list=[];
  for(const name of names.filter(n=>/^(KRISTINE|WW)-\d{1,12}\.json$/.test(n)).slice(0,2000)){
    let doc;try{doc=JSON.parse(await fs.readFile(path.join(dir,name),"utf8"));doc.info=validate(doc.info)}catch{continue}
    const v=doc.info,p=locations(root,v);
    if(v.project!==String(project))continue;
    if(!(await fs.stat(p.pdf).then(s=>s.isFile()).catch(()=>false)))continue;
    const storedName=path.basename(p.pdf);
    list.push({
      id:"issued-invoice-"+v.source+"-"+v.invoiceId,type:"issued_invoice",
      documentType:"invoice",name:(v.kind==="SR"?"Schlussrechnung ":v.kind==="TR"?"Teilrechnung ":"Rechnung ")+v.number+".pdf",
      invoiceNumber:v.number,invoiceKind:v.kind,source:v.source,documentDate:v.date,
      url:"/admin/api/job/"+encodeURIComponent(v.project)+"/documentation/file?name="+encodeURIComponent(storedName),
      storedName,importedAt:doc.archivedAt||"",
    });
  }
  return list.sort((a,b)=>b.documentDate.localeCompare(a.documentDate)||b.invoiceNumber.localeCompare(a.invoiceNumber));
}
module.exports={archiveInvoice,listInvoiceDocuments,validate};

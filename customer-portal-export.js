"use strict";

const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto");
const {readCustomerInvoices,invoiceView}=require("./customer-portal-invoices");
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const safeName=value=>String(value||"Datei").replace(/[^\p{L}\p{N}_.-]/gu,"_").slice(0,100);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const scopeKey=ctx=>JSON.stringify([ctx.jobId,ctx.grant.contact,[...ctx.jobIds].sort(),ctx.portal.modules]);
const write=(file,value)=>{const tmp=file+".tmp";fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);};

function offlinePoints(rows){
  if(!rows.length)return "<p>Keine Nachrichten oder Wünsche hinterlegt.</p>";
  const stamp=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString("de-AT",{timeZone:"Europe/Vienna",dateStyle:"medium",timeStyle:"short"}):"Zeitpunkt nicht gespeichert";
  return `<table style="width:100%;text-align:left;border-spacing:0 14px"><thead><tr><th>Datum</th><th>Status</th><th>Überschrift</th></tr></thead><tbody>${rows.map(row=>`<tr><td style="vertical-align:top">${esc(stamp(row.date))}</td><td style="vertical-align:top">${row.status==="done"?"Erledigt":"Offen"}</td><td><details><summary>${esc(row.title||row.area||"Nachricht")}</summary>${row.area?`<p>${esc(row.area)}</p>`:""}<p class="text">${esc(row.text)}</p><h3>Verlauf</h3><ol>${(row.history||[]).map(event=>`<li>${event.kind==="submitted"?"Erfasst und an Farben Krista übergeben":event.status==="done"?"Erledigt":"Wieder geöffnet"} · ${esc(stamp(event.date))}</li>`).join("")}</ol></details></td></tr>`).join("")}</tbody></table>`;
}

function offlinePage(data,missing){
  const money=value=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR"}).format(Number(value)||0);
  const files=group=>data.files.filter(row=>row.group===group).map(row=>`<li><a href="${esc(row.url)}">${esc(row.name)}</a> · Akte ${esc(row.jobId)}</li>`).join("");
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projektakte ${esc(data.number)}</title><style>body{font:16px/1.6 system-ui;margin:2rem auto;max-width:1000px;padding:0 1rem;color:#24382b}a{color:#276a3b}nav{display:flex;gap:1rem;flex-wrap:wrap}section,article{padding:1rem;border:1px solid #deded4;border-radius:12px;margin:1rem 0}h1,h2{line-height:1.2}.text{white-space:pre-wrap}small{color:#52695a}</style><h1>${esc(data.name)} · ${esc(data.number)}</h1><p>Farben Krista · Gespeicherter Stand ${esc(data.exportedAt)}. Diese Projektakte lässt sich nach dem Entpacken ohne Internet öffnen.</p><nav><a href="#akten">Akten</a>${data.modules.projectFile?'<a href="#dokumente">Dokumente</a><a href="#rechnungen">Rechnungen</a><a href="#fotos">Fotos</a><a href="#material">Materialien</a>':""}${data.modules.regie?'<a href="#regie">Regieberichte</a>':""}${data.modules.communication||data.modules.projectPoints?'<a href="#punkte">Nachrichten & Wünsche</a>':""}</nav>${missing.length?`<section><h2>Noch nicht enthalten</h2><ul>${missing.map(text=>`<li>${esc(text)}</li>`).join("")}</ul></section>`:""}<section id="akten"><h2>Einzelakten</h2>${data.projects.map(row=>`<p><strong>${esc(row.jobId)} · ${esc(row.name)}</strong><br>${esc(row.address)}</p>`).join("")}</section>${data.modules.projectFile?`<section id="dokumente"><h2>Dokumente</h2><ul>${files("documents")||"<li>Keine Dokumente hinterlegt.</li>"}</ul></section><section id="rechnungen"><h2>Rechnungen</h2>${data.invoices.map(row=>`<article><strong>${esc(row.kind)} ${esc(row.number)}</strong><p>${esc(row.date)} · Akte ${esc(row.jobId)} · ${money(row.gross)} brutto (${money(row.net)} netto)</p>${row.url?`<a href="${esc(row.url)}">Original-PDF</a>`:"<p>Original-PDF nicht enthalten.</p>"}</article>`).join("")||"<p>Keine ausgestellten Rechnungen hinterlegt.</p>"}</section><section id="fotos"><h2>Fotos & Videos</h2><ul>${files("photos")||"<li>Keine Fotos hinterlegt.</li>"}</ul></section><section id="material"><h2>Materialien & Oberflächen</h2>${data.materials.map(row=>`<article><strong>${esc(row.name)}</strong><p>Akte ${esc(row.jobId)}${row.use?" · "+esc(row.use):""}</p>${row.sources.map(source=>`<p>${source.quantity===null?"Menge nicht angegeben":esc(source.quantity)+" "+esc(source.unit)} · ${esc(source.source)} ${esc(source.reference)} ${esc(source.date)}</p>`).join("")}</article>`).join("")||"<p>Keine Materialangaben hinterlegt.</p>"}</section>`:""}${data.modules.regie?`<section id="regie"><h2>Regieberichte</h2>${data.reports.map(row=>`<article><h3>${esc(row.number)}</h3><p>${esc(row.date)} · Akte ${esc(row.jobId)} · ${esc(row.hours)} h</p><p class="text">${esc(row.description)}</p><p>${esc(row.employees)}</p>${row.materials.map(m=>`<p>${esc(m.name)} · ${esc(m.quantity)} ${esc(m.unit)}</p>`).join("")}${row.url?`<a href="${esc(row.url)}">Original-PDF</a>`:""}</article>`).join("")}</section>`:""}${data.modules.communication||data.modules.projectPoints?`<section id="punkte"><h2>Nachrichten & Wünsche</h2>${offlinePoints(data.points)}</section>`:""}<p>Die strukturierten Angaben finden Sie zusätzlich in <a href="projekt.json">projekt.json</a>.</p></html>`;
}

function registerCustomerExports(app,{dataDir,context,catalog,readJobMeta,pointRows,readInvoicePdf,closePortal,origin,now=Date.now}){
  const root=path.join(dataDir,"_system/customer-access/exports"),runner=crypto.randomUUID(),active=new Map();
  fs.mkdirSync(root,{recursive:true});
  const metaPath=id=>path.join(root,id+".json"),zipPath=id=>path.join(root,id+".zip");
  const guard=fn=>async(req,res)=>{try{await fn(req,res)}catch(error){if(!res.headersSent)res.status(error.status||500).json({ok:false,error:error.status?error.message:"Die Projektakte konnte nicht vorbereitet werden. Bitte erneut versuchen."});}};
  async function authorized(req,mutate=false){
    const ctx=await context(req);
    if(mutate&&(req.headers.origin!==origin||req.headers["x-csrf-token"]!==ctx.session.csrf))throw fail(403,"Diese Aktion ist nicht erlaubt.");
    return ctx;
  }
  function find(ctx,id){
    if(!/^[a-f0-9]{32}$/.test(id||""))throw fail(404,"Download nicht gefunden.");
    let job;try{job=JSON.parse(fs.readFileSync(metaPath(id),"utf8"));}catch{throw fail(404,"Download nicht gefunden.");}
    if(job.grantId!==ctx.grant.id||job.scope!==scopeKey(ctx)||job.expiresAt<=now())throw fail(404,"Bitte den Download für die aktuelle Freigabe erneut vorbereiten.");
    if(job.status==="preparing"&&job.runner!==runner)throw fail(409,"Die Vorbereitung wurde unterbrochen. Bitte den Download erneut starten.");
    return job;
  }
  async function prepare(req,ctx,job){
    const missing=[],entries=[];
    try{
      const source=await catalog(ctx),files=[],urlMap=new Map();
      for(const file of source.files.values()){
        const filename=`Dateien/${safeName(file.jobId)}/${file.id}-${safeName(path.basename(file.physical))}`;
        if(!fs.existsSync(file.physical)){missing.push(`Datei ${file.name} aus Akte ${file.jobId}`);continue;}
        entries.push({physical:file.physical,name:filename});urlMap.set(file.url,filename);
        files.push({jobId:file.jobId,name:file.name,type:file.type,group:file.group,date:file.date,url:filename});
      }
      if(!source.materialStatus.complete)missing.push("Ein Teil der Materialnachweise konnte nicht geladen werden.");
      const billing=ctx.portal.modules.projectFile?await readCustomerInvoices(dataDir,await Promise.all(ctx.jobIds.map(async jobId=>({...await readJobMeta(jobId),jobId})))):{entries:[],complete:true};
      if(!billing.complete)missing.push("Der Rechnungsstand ist noch nicht für alle Akten übernommen.");
      const invoices=[];let archiveOffline=false;
      for(const entry of billing.entries){
        const invoice=invoiceView(entry,false);invoice.url=null;
        try{
          if(!readInvoicePdf)throw Error("No archive connection");
          const cached=path.join(dataDir,entry.jobId,"_customer-invoices",entry.id+".pdf");
          if(archiveOffline&&!fs.existsSync(cached))throw fail(503,"Archiv nicht erreichbar");
          const body=await readInvoicePdf(entry),name=`Rechnungen/${safeName(entry.jobId)}/${entry.id}-${safeName(invoice.number||"Rechnung")}.pdf`;
          entries.push(fs.existsSync(cached)?{physical:cached,name}:{body,name});invoice.url=name;
        }catch(error){if(error.status===503)archiveOffline=true;missing.push(`Original-PDF der Rechnung ${invoice.number||"ohne Nummer"} aus Akte ${entry.jobId}`);}
        invoices.push(invoice);job.fileCount=entries.length;write(metaPath(job.id),job);
      }
      if(scopeKey(await context(req))!==job.scope)throw fail(409,"Die Freigabe hat sich geändert. Bitte erneut herunterladen.");
      const data={name:ctx.meta.name,number:ctx.label,exportedAt:new Date(now()).toISOString(),modules:ctx.portal.modules,projects:source.projects,files,materials:source.materials,invoices,
        reports:source.reports.map(row=>({...row,url:row.url?urlMap.get(row.url)||null:null})),regieSummary:source.regieSummary,points:pointRows(ctx)};
      const temporary=zipPath(job.id)+".tmp",output=fs.createWriteStream(temporary,{mode:0o600}),archive=require("archiver")("zip",{zlib:{level:1}});
      await new Promise((resolve,reject)=>{
        const stop=error=>{archive.abort();output.destroy();reject(error);};
        output.once("close",resolve);output.once("error",stop);archive.once("error",stop);archive.once("warning",stop);archive.pipe(output);
        archive.append(offlinePage(data,missing),{name:"START.html"});archive.append(JSON.stringify(data,null,2),{name:"projekt.json"});
        for(const entry of entries){if(entry.physical)archive.file(entry.physical,{name:entry.name});else archive.append(entry.body,{name:entry.name});}
        archive.finalize().catch(reject);
      });
      if(scopeKey(await context(req))!==job.scope)throw fail(409,"Die Freigabe hat sich geändert. Bitte erneut herunterladen.");
      await fsp.rename(temporary,zipPath(job.id));job.status="ready";job.complete=!missing.length;job.missing=missing;job.fileCount=entries.length;write(metaPath(job.id),job);
    }catch(error){job.status="failed";job.error=error.status?error.message:"Die Projektakte konnte nicht vorbereitet werden. Bitte erneut versuchen.";write(metaPath(job.id),job);await fsp.rm(zipPath(job.id)+".tmp",{force:true}).catch(()=>{});}
    finally{active.delete(ctx.grant.id);}
  }
  app.post("/kundenportal/api/exports",guard(async(req,res)=>{
    const ctx=await authorized(req,true);
    if(active.has(ctx.grant.id))return res.json({ok:true,id:active.get(ctx.grant.id)});
    if(active.size>=2)throw fail(429,"Gerade werden weitere Projektakten vorbereitet. Bitte in Kürze erneut versuchen.");
    for(const name of fs.readdirSync(root).filter(name=>/^[a-f0-9]{32}\.json$/.test(name))){
      try{const old=JSON.parse(fs.readFileSync(path.join(root,name),"utf8"));if(old.expiresAt<now()){for(const suffix of [".json",".zip",".zip.tmp"])fs.rmSync(path.join(root,name.slice(0,-5)+suffix),{force:true});}}catch{}
    }
    const id=crypto.randomBytes(16).toString("hex"),job={id,grantId:ctx.grant.id,scope:scopeKey(ctx),runner,status:"preparing",fileCount:0,complete:false,expiresAt:now()+86400000};
    write(metaPath(id),job);active.set(ctx.grant.id,id);res.status(202).json({ok:true,id});void prepare(req,ctx,job);
  }));
  app.get("/kundenportal/api/exports/:id",guard(async(req,res)=>{
    const ctx=await authorized(req),job=find(ctx,req.params.id);
    res.json({ok:true,id:job.id,status:job.status,complete:job.complete,delivered:!!job.deliveredAt,fileCount:job.fileCount,missing:job.missing||[],error:job.error||"",downloadUrl:job.status==="ready"?`/kundenportal/api/exports/${job.id}/download`:null});
  }));
  app.get("/kundenportal/api/exports/:id/download",guard(async(req,res)=>{
    const ctx=await authorized(req),job=find(ctx,req.params.id);if(job.status!=="ready")throw fail(409,"Der Download wird noch vorbereitet.");
    res.download(zipPath(job.id),`Projektakte_${safeName(ctx.label)}.zip`,error=>{
      if(!error){job.deliveredAt=now();try{write(metaPath(job.id),job);}catch{}}
      else if(!res.headersSent)res.status(500).json({ok:false,error:"Der Download wurde unterbrochen. Ihr Zugang bleibt geöffnet."});
    });
  }));
  app.post("/kundenportal/api/close",guard(async(req,res)=>{
    const ctx=await authorized(req,true);if(ctx.grant.preview)throw fail(403,"Der Kundenzugang kann in der Vorschau nicht geschlossen werden.");
    if(req.body?.afterExport){const job=find(ctx,String(req.body.afterExport));if(!job.complete||!job.deliveredAt)throw fail(409,"Bitte zuerst die vollständige Projektakte herunterladen. Ihr Zugang bleibt geöffnet.");}
    if(!closePortal)throw fail(503,"Der Kundenzugang kann derzeit nicht geschlossen werden.");
    await closePortal(ctx);res.clearCookie("krista_kundenportal",{httpOnly:true,secure:true,sameSite:"lax",path:"/kundenportal"});res.json({ok:true,closed:true});
  }));
}

module.exports={registerCustomerExports,offlinePage};

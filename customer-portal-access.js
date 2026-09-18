"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { sanitizeCustomerPortal } = require("./customer-portal");
const { createAliasResolver } = require("./job-renumber");
const { dedupeReports } = require("./public/ui/regie-billing-state");
const { readMaterialSources, collectCustomerMaterials } = require("./customer-portal-materials");
const { readCustomerInvoices, invoiceView } = require("./customer-portal-invoices");
const { registerCustomerExports } = require("./customer-portal-export");
const { pointTitle, customerPointView } = require("./customer-portal-points");
const safeId = id => /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ""));
const hash = text => crypto.createHash("sha256").update(String(text)).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { if(e.code === "ENOENT") return fallback; throw e; } };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); const tmp=file+"."+crypto.randomUUID()+".tmp"; try { fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600}); fs.renameSync(tmp,file); } finally { fs.rmSync(tmp,{force:true}); } };
const clean = (value, max=500) => String(value || "").trim().slice(0,max);
const documentNumber = value => { if(typeof value==="number")return Number.isFinite(value)?value:0;const parsed=Number(String(value||"").replace(/\s/g,"").replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",","."));return Number.isFinite(parsed)?parsed:0; };
const fail = (status, message) => Object.assign(new Error(message),{status});
const cookieName = "krista_kundenportal";
const cookieOptions = {httpOnly:true,secure:true,sameSite:"lax",path:"/kundenportal"};
const fingerprint = portal => hash(JSON.stringify([portal.customerEmail.toLowerCase(),portal.customerPhone.replace(/\D/g,""),portal.customerName]));

// Customer points have their own durable files. The ordinary task reader merges
// them by ID, so an old browser's bulk save cannot discard a new customer point.
function mergePortalTasks(dataDir, tasks) {
  const dir=path.join(dataDir,"_kristine/customer-portal-tasks"), known=new Set(tasks.map(row=>row.id)), rows=[...tasks];
  if(!fs.existsSync(dir))return rows;
  for(const name of fs.readdirSync(dir).filter(name=>/^[a-f0-9-]+\.json$/.test(name))) {
    const task=read(path.join(dir,name),null);if(task?.id&&!known.has(task.id)){rows.push(task);known.add(task.id)}
  }
  return rows;
}

function registerCustomerAccess(app, options) {
  const {dataDir,requireAdmin,readJobMeta,collectionMembers,readDocumentation,listJobMedia,readEmployees}=options;
  const root=path.join(dataDir,"_system/customer-access"), origin=new URL(options.publicBaseUrl || "https://protokoll.krista.at").origin;
  const now=options.now || Date.now, aliases=createAliasResolver(dataDir);
  const grantPath=id=>path.join(root,"invitations",id+".json");
  const sessionPath=value=>path.join(root,"sessions",hash(value)+".json");
  const guard=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){res.status(e.status||500).json({ok:false,error:e.status?e.message:"Kundenportal derzeit nicht verfügbar. Bitte erneut versuchen."})}};
  async function mainId(id) {
    if(!safeId(id))throw fail(404,"Akte nicht gefunden.");
    const resolved=await options.resolveMain?.(id) || id;
    if(!safeId(resolved))throw fail(404,"Akte nicht gefunden.");
    return aliases.canonical(resolved);
  }
  async function scope(id) {
    const jobId=await mainId(id),meta=await readJobMeta(jobId),portal=sanitizeCustomerPortal(meta.customerPortal);
    if(!meta.name||portal.status==="off")throw fail(403,"Dieser Kundenzugang ist nicht freigegeben.");
    const members=portal.mode==="collection" ? await collectionMembers(jobId) || [] : [];
    const selected=new Set(portal.includedJobIds);
    const jobIds=[...new Set([jobId,...members.filter(id=>id!==jobId&&selected.has(id))])].filter(safeId);
    return {jobId,meta,portal,jobIds,label:portal.mode==="collection"?"S"+jobId:jobId};
  }
  function readSession(req) {
    const raw=String(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith(cookieName+"="))?.slice(cookieName.length+1)||"";
    return /^[A-Za-z0-9_-]{43}$/.test(raw)?read(sessionPath(raw),null):null;
  }
  async function context(req) {
    const session=readSession(req);
    if(!session||session.expiresAt<=now())throw fail(401,"Bitte den persönlichen Einladungslink aus WhatsApp öffnen.");
    const grant=read(grantPath(session.grantId),null);
    if(!grant||grant.revoked)throw fail(401,"Dieser Zugang wurde beendet. Bitte einen neuen Link anfordern.");
    const current=await scope(grant.jobId);
    if(grant.contact!==fingerprint(current.portal))throw fail(401,"Die Freigabe wurde geändert. Bitte den neuen Einladungslink öffnen.");
    return {...current,session,grant,jobIds:current.jobIds.filter(id=>grant.jobIds.includes(id))};
  }
  function sameOrigin(req) { if(req.headers.origin!==origin)throw fail(403,"Anfrage nicht erlaubt."); }
  const attempts=new Map();
  function throttle(req) {
    const key=req.ip||req.socket?.remoteAddress||"",time=now(),previous=attempts.get(key),record=previous&&previous.until>time?previous:{count:0,until:time+600000};
    if(++record.count>30)throw fail(429,"Zu viele Versuche. Bitte später erneut versuchen.");attempts.set(key,record);
    if(attempts.size>1000)for(const [key,row]of attempts)if(row.until<=time)attempts.delete(key);
  }
  function resetJob(jobId) {
    const dir=path.join(root,"invitations");if(!fs.existsSync(dir))return;
    for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n))) {
      const file=path.join(dir,name),grant=read(file,null);if(grant?.jobId===jobId&&!grant.revoked)write(file,{...grant,revoked:true});
    }
  }
  app.use("/kundenportal",(req,res,next)=>{
    res.setHeader("Cache-Control","private, no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");next();
  });
  app.get("/kundenportal",(_req,res)=>res.sendFile(path.join(options.publicDir,"kundenportal.html")));
  app.get("/kundenportal/assets/:name",(req,res)=>{
    if(!["kundenportal.js","kundenportal.css"].includes(req.params.name))return res.sendStatus(404);
    res.sendFile(path.join(options.publicDir,"ui",req.params.name));
  });
  app.post("/admin/api/job/:jobId/customer-portal/invitation",guard(async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const current=await scope(req.params.jobId);
    if(!Object.values(current.portal.modules).some(Boolean))throw fail(400,"Bitte mindestens einen Bereich freigeben.");
    const id=crypto.randomBytes(16).toString("hex"),secret=random(),preview=req.body?.preview===true;
    const grant={id,jobId:current.jobId,jobIds:current.jobIds,contact:fingerprint(current.portal),secretHash:hash(secret),createdAt:now(),expiresAt:now()+(preview?600000:7*86400000),preview};
    write(grantPath(id),grant);
    // Secrets stay in the fragment: neither access logs nor referrers receive it.
    res.setHeader("Cache-Control","no-store");res.json({ok:true,portalUrl:origin+"/kundenportal#zugang="+id+"."+secret,expiresAt:new Date(grant.expiresAt).toISOString(),jobId:current.jobId});
  }));
  app.post("/kundenportal/api/session",guard(async(req,res)=>{
    sameOrigin(req);throttle(req);
    const match=String(req.body?.ticket||"").match(/^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/);
    if(!match)throw fail(401,"Bitte einen gültigen Einladungslink öffnen.");
    const grant=read(grantPath(match[1]),null),digest=hash(match[2]);
    if(!grant||grant.revoked||grant.expiresAt<=now()||!crypto.timingSafeEqual(Buffer.from(grant.secretHash),Buffer.from(digest)))throw fail(401,"Der Einladungslink ist abgelaufen oder wurde gesperrt. Bitte Farben Krista um einen neuen Link bitten.");
    const current=await scope(grant.jobId);
    if(grant.contact!==fingerprint(current.portal))throw fail(401,"Die Freigabe wurde geändert. Bitte den neuen Link verwenden.");
    const secret=random(),session={grantId:grant.id,expiresAt:now()+(grant.preview?600000:30*86400000),csrf:random()};
    write(sessionPath(secret),session);
    res.cookie(cookieName,secret,{...cookieOptions,maxAge:session.expiresAt-now()});res.json({ok:true});
  }));
  app.post("/kundenportal/api/logout",guard(async(req,res)=>{
    sameOrigin(req);const session=readSession(req);if(session){const raw=String(req.headers.cookie).split(";").map(s=>s.trim()).find(s=>s.startsWith(cookieName+"="))?.slice(cookieName.length+1);if(raw)fs.rmSync(sessionPath(raw),{force:true})}
    res.clearCookie(cookieName,cookieOptions);res.json({ok:true});
  }));
  function secureFile(jobId,relative) {
    if(!safeId(jobId)||!relative||relative.includes("..")||path.isAbsolute(relative))return null;
    const file=path.resolve(dataDir,jobId,relative),base=path.resolve(dataDir,jobId)+path.sep;
    if(!file.startsWith(base)||!fs.existsSync(file))return null;
    const actual=fs.realpathSync(file),actualBase=fs.realpathSync(path.join(dataDir,jobId))+path.sep;
    return actual.startsWith(actualBase)&&fs.statSync(actual).isFile()?actual:null;
  }
  async function catalog(ctx, includeMaterials = true) {
    const files=new Map(),projects=[],reports=[],materials=[],emptyRegie=()=>({hours:0,labor:0,material:0,total:0,count:0}),regieSummary={billed:emptyRegie(),open:emptyRegie(),total:emptyRegie()};
    const materialSources = ctx.portal.modules.projectFile && includeMaterials
      ? await readMaterialSources({ dataDir, jobIds:ctx.jobIds, canonicalId:id=>aliases.canonical(id), listDaysForJob:options.listDaysForJob, regiePathForDay:options.regiePathForDay })
      : null;
    const add=(jobId,type,name,physical,group,date="")=>{
      if(!physical)return null;const id=hash(jobId+"|"+type+"|"+physical).slice(0,32),url="/kundenportal/api/file/"+encodeURIComponent(jobId)+"/"+id;
      if(!files.has(id))files.set(id,{id,jobId,name:clean(name,180),type,group,date,url,physical});return url;
    };
    for(const jobId of ctx.jobIds) {
      const meta=jobId===ctx.jobId?ctx.meta:await readJobMeta(jobId);
      projects.push({jobId,name:meta.name,address:[meta.street,meta.houseNumber,meta.postalCode,meta.city].filter(Boolean).join(" ")});
      const documents=(await readDocumentation(jobId)).filter(row=>row&&typeof row==="object");
      if(ctx.portal.modules.projectFile) {
        const calc=read(path.join(dataDir,jobId,".order-calculation.json"),{}),doc=calc.sourceDocument;
        if(doc?.storedName&&path.basename(doc.storedName)===doc.storedName)add(jobId,"pdf",doc.name||"Auftrag",secureFile(jobId,"_auftrag/"+doc.storedName),"documents");
        for(const row of documents.filter(row=>row.customerVisible===true&&row.type!=="regie_report"))if(row.storedName&&path.basename(row.storedName)===row.storedName&&/\.pdf$/i.test(row.storedName))add(jobId,"pdf",row.name||"Dokument",secureFile(jobId,"_documentation/"+row.storedName),"documents");
        for(const row of await listJobMedia({dataDir,jobId,includeCollection:false})) {
          if(!/\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i.test(row.file||""))continue;
          const normalized=String(row.file).replace(/\\/g,"/"),first=normalized.split("/")[0];
          let physical=null;
          if(aliases.canonical(first)===jobId)physical=secureFile(jobId,normalized.split("/").slice(1).join("/"));
          else if(normalized.startsWith("_kristine/media/")) {
            const full=path.resolve(dataDir,normalized),mediaRoot=path.resolve(dataDir,"_kristine/media")+path.sep;
            if(!normalized.includes("..")&&fs.existsSync(full)&&fs.realpathSync(full).startsWith(mediaRoot))physical=full;
          }
          add(jobId,/\.(mp4|mov|webm)$/i.test(normalized)?"video":"photo",row.content||row.filename||"Baustellenfoto",physical,"photos",row.date||"");
        }
        if (materialSources) materials.push(...collectCustomerMaterials({ jobId, metaRows:meta.surfaceMaterialMeta, documents, days:materialSources.days.get(jobId), bookings:materialSources.bookings.get(jobId) }));
      }
      if(ctx.portal.modules.regie)for(const row of dedupeReports(documents.filter(row=>row.type==="regie_report"))) {
        const physical=row.storedName&&path.basename(row.storedName)===row.storedName&&/\.pdf$/i.test(row.storedName)?secureFile(jobId,"_documentation/"+row.storedName):null;
        const url=add(jobId,"pdf",row.reportNumber||row.name||"Regiebericht",physical,"regie",row.reportDate||"");
        const hours=Math.max(0,documentNumber(row.totalHours)),labor=Math.max(0,documentNumber(row.laborCost)),materialValue=row.materialCost??row.materialTotal,material=Math.max(0,documentNumber(materialValue)),hasDetails=row.laborCost!==undefined&&materialValue!==undefined,totalNet=Math.max(0,documentNumber(row.totalNet)),net=hasDetails?labor+material:totalNet||labor+material;
        const manual=String(row.billingStatus||"").toLowerCase(),settled=["geschlossen","abgerechnet"].includes(String(meta.status||"").trim().toLowerCase()),automatic=Boolean(String(row.billedDocumentId||"").trim());
        const status=settled||manual==="billed"||(manual!=="open"&&automatic)?"billed":"open",target=regieSummary[status];
        for(const bucket of [target,regieSummary.total]){bucket.hours+=hours;bucket.labor+=labor;bucket.material+=material;bucket.total+=net;bucket.count++}
        reports.push({jobId,id:clean(row.id,100),number:clean(row.reportNumber||row.name,120),date:clean(row.reportDate,10),hours,labor,material,net,status,description:clean(row.description,12000),employees:clean(row.employees,1000),materials:(row.materials||[]).map(m=>({name:clean(m.name),quantity:Number(m.quantity)||0,unit:clean(m.unit,30)})),url});
      }
    }
    return {files,projects,reports,regieSummary,materials,materialStatus:{complete:!materialSources?.unavailable.length,unavailable:materialSources?.unavailable||[]}};
  }
  function pointRows(ctx) {
    const folder=path.join(dataDir,ctx.jobId,"_customer-portal"),rows=fs.existsSync(folder)?fs.readdirSync(folder).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).map(name=>read(path.join(folder,name),null)).filter(Boolean):[];
    const tasks=new Map(mergePortalTasks(dataDir,read(path.join(dataDir,"_kristine/tasks.json"),[])).map(task=>[task.id,task]));
    return rows.filter(row=>(row.source==="office"||row.contact===ctx.grant.contact)&&ctx.portal.modules[row.module]).map(row=>customerPointView(row,tasks.get(row.taskId))).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  }
  function storedPointRows(jobId) {
    const folder=path.join(dataDir,jobId,"_customer-portal"),rows=fs.existsSync(folder)?fs.readdirSync(folder).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).map(name=>read(path.join(folder,name),null)).filter(Boolean):[];
    const tasks=new Map(mergePortalTasks(dataDir,read(path.join(dataDir,"_kristine/tasks.json"),[])).map(task=>[task.id,task]));
    return rows.map(row=>customerPointView(row,tasks.get(row.taskId))).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  }
  function pointPhotos(value,jobId,pointId) {
    const rows=Array.isArray(value)?value:[];
    if(rows.length>6)throw fail(400,"Bitte höchstens 6 Fotos pro Punkt auswählen.");
    let total=0;
    return rows.map(row=>{
      const match=String(row?.data||"").match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if(!match)throw fail(400,"Ein Foto hat ein nicht unterstütztes Format.");
      const buffer=Buffer.from(match[2],"base64");total+=buffer.length;
      if(!buffer.length||buffer.length>5*1024*1024||total>15*1024*1024)throw fail(400,"Die Fotos sind zu groß. Maximal 5 MB je Foto und 15 MB insgesamt.");
      const id=crypto.randomUUID(),extension={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"}[match[1]],relative=path.join("_customer-portal","_files",pointId,id+"."+extension);
      const file=path.join(dataDir,jobId,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,buffer,{mode:0o600});
      return {id,name:clean(row?.name,180)||"Foto",type:match[1],file:relative.replace(/\\/g,"/")};
    });
  }
  async function createPoint({jobId,meta,portal,contact,source,creatorName,body}) {
    const module=body?.module;if(!["communication","projectPoints"].includes(module))throw fail(400,"Ungültiger Bereich.");
    const text=clean(body?.text,5000),area=clean(body?.area,140),title=pointTitle({title:clean(body?.title,140),text,area});if(!text)throw fail(400,"Bitte eine Nachricht eingeben.");
    const responsibility=body?.responsibility==="bauherr"?"bauherr":"krista",id=crypto.randomUUID(),taskId="customer_"+id,date=new Date(now()).toISOString();
    let photos=[];try{photos=pointPhotos(body?.photos,jobId,id)}catch(error){fs.rmSync(path.join(dataDir,jobId,"_customer-portal","_files",id),{recursive:true,force:true});throw error}
    const employees=typeof readEmployees==="function"?await readEmployees():[],owner=employees.find(row=>/^alexander krista$/i.test(row.name||""));
    const task={id:taskId,title:(module==="communication"?"Kundennachricht":"Kundenpunkt prüfen")+" · "+meta.name+" · "+title.slice(0,70),jobId,jobName:meta.name,assigneeId:owner?.id||"admin",assigneeName:owner?.name||"Alexander Krista",taskType:"Sonstiges",priority:"normal",creatorId:source==="office"?"krista-office":"customer-portal",creatorName:creatorName||portal.customerName||meta.name,contactName:portal.customerName,contactPhone:portal.customerPhone,contactEmail:portal.customerEmail,customerResponsibility:responsibility,reminder:text.slice(0,500),status:"open",createdAt:date,completedAt:null};
    write(path.join(dataDir,jobId,"_customer-portal",id+".json"),{id,taskId,module,title,text,area,responsibility,photos,date,contact,source,history:[{kind:"submitted",status:"open",date}]});
    write(path.join(dataDir,"_kristine/customer-portal-tasks",id+".json"),task);
    return customerPointView({id,taskId,module,title,text,area,responsibility,photos,date,history:[{kind:"submitted",status:"open",date}]},task);
  }
  app.get("/kundenportal/api/project",guard(async(req,res)=>{
    const ctx=await context(req),data=await catalog(ctx);
    const billing = ctx.portal.modules.projectFile ? await readCustomerInvoices(dataDir, await Promise.all(ctx.jobIds.map(async jobId=>({...await readJobMeta(jobId),jobId})))) : {entries:[],complete:true,unavailable:[],syncedAt:null};
    res.json({ok:true,name:ctx.meta.name,customerName:ctx.portal.customerName,number:ctx.label,mainJobId:ctx.jobId,modules:ctx.portal.modules,csrf:ctx.session.csrf,preview:!!ctx.grant.preview,projects:data.projects,reports:data.reports,regieSummary:data.regieSummary,materials:data.materials,materialStatus:data.materialStatus,invoices:billing.entries.map(entry=>invoiceView(entry,!!options.readInvoicePdf)),invoiceStatus:{complete:billing.complete,unavailable:billing.unavailable,syncedAt:billing.syncedAt},files:[...data.files.values()].map(({physical,...row})=>row),points:pointRows(ctx)});
  }));
  app.get("/kundenportal/api/invoice/:jobId/:id",guard(async(req,res)=>{
    const ctx=await context(req),jobId=req.params.jobId;
    if(!ctx.portal.modules.projectFile||!ctx.jobIds.includes(jobId)||!options.readInvoicePdf)throw fail(404,"Rechnung nicht freigegeben.");
    const billing=await readCustomerInvoices(dataDir,[{...await readJobMeta(jobId),jobId}]),entry=billing.entries.find(row=>row.id===req.params.id);
    if(!entry)throw fail(404,"Rechnung nicht freigegeben.");
    const pdf=await options.readInvoicePdf(entry);
    const current=await context(req); // Recheck after a potentially slow archive request.
    if(!current.portal.modules.projectFile||!current.jobIds.includes(jobId))throw fail(404,"Rechnung nicht freigegeben.");
    res.type("application/pdf").setHeader("Content-Disposition",'inline; filename="Rechnung.pdf"');res.send(pdf);
  }));
  app.get("/kundenportal/api/file/:jobId/:id",guard(async(req,res)=>{
    const ctx=await context(req);
    if(!ctx.jobIds.includes(req.params.jobId))throw fail(404,"Datei nicht freigegeben.");
    const data=await catalog({...ctx,jobIds:[req.params.jobId]},false),file=data.files.get(req.params.id);
    if(!file)throw fail(404,"Datei nicht freigegeben.");
    res.sendFile(file.physical,{headers:{"Cache-Control":"private, no-store"}});
  }));
  app.get("/kundenportal/api/point-photo/:pointId/:photoId",guard(async(req,res)=>{
    const ctx=await context(req);if(!/^[a-f0-9-]{36}$/.test(req.params.pointId)||!/^[a-f0-9-]{36}$/.test(req.params.photoId))throw fail(404,"Foto nicht gefunden.");
    const point=read(path.join(dataDir,ctx.jobId,"_customer-portal",req.params.pointId+".json"),null);
    if(!point||(point.source!=="office"&&point.contact!==ctx.grant.contact)||!ctx.portal.modules[point.module])throw fail(404,"Foto nicht freigegeben.");
    const photo=(point.photos||[]).find(row=>row.id===req.params.photoId),file=photo&&secureFile(ctx.jobId,photo.file);
    if(!file)throw fail(404,"Foto nicht gefunden.");
    res.type(photo.type).sendFile(file,{headers:{"Cache-Control":"private, no-store"}});
  }));
  app.get("/admin/api/job/:jobId/customer-portal/points",guard(async(req,res)=>{
    if(!requireAdmin(req,res))return;const jobId=await mainId(req.params.jobId);await readJobMeta(jobId);res.json({ok:true,points:storedPointRows(jobId)});
  }));
  app.post("/admin/api/job/:jobId/customer-portal/points",guard(async(req,res)=>{
    if(!requireAdmin(req,res))return;const jobId=await mainId(req.params.jobId),meta=await readJobMeta(jobId),portal=sanitizeCustomerPortal(meta.customerPortal);
    const point=await createPoint({jobId,meta,portal,contact:fingerprint(portal),source:"office",creatorName:"Farben Krista · Besprechungsprotokoll",body:{...req.body,module:"projectPoints"}});
    res.status(201).json({ok:true,point});
  }));
  app.post("/kundenportal/api/point",guard(async(req,res)=>{
    sameOrigin(req);const ctx=await context(req);if(req.headers["x-csrf-token"]!==ctx.session.csrf||ctx.grant.preview)throw fail(403,"Diese Aktion ist nicht erlaubt.");
    const module=req.body?.module;if(!["communication","projectPoints"].includes(module)||!ctx.portal.modules[module])throw fail(403,"Dieser Bereich ist nicht freigegeben.");
    const point=await createPoint({jobId:ctx.jobId,meta:ctx.meta,portal:ctx.portal,contact:ctx.grant.contact,source:"customer",creatorName:ctx.portal.customerName||ctx.meta.name,body:req.body});
    res.status(201).json({ok:true,id:point.id,point});
  }));
  registerCustomerExports(app,{dataDir,context,catalog,readJobMeta,pointRows,readInvoicePdf:options.readInvoicePdf,origin,now,
    closePortal:options.writeJobMeta?async ctx=>{
      const current=sanitizeCustomerPortal((await readJobMeta(ctx.jobId)).customerPortal);
      if(fingerprint(current)!==ctx.grant.contact)throw fail(409,"Die Freigabe hat sich geändert. Bitte erneut öffnen.");
      await options.writeJobMeta(ctx.jobId,{customerPortal:{...current,status:"off",updatedAt:new Date(now()).toISOString()}});
      resetJob(ctx.jobId);
      try{await options.appendJobHistory?.(ctx.jobId,{type:"customer_portal_closed",title:"Kunde hat seinen Portalzugang geschlossen",detail:"Online-Zugang beendet; interne Projektunterlagen bleiben erhalten.",source:"Kundenportal"});}catch{console.error("Kundenzugang geschlossen; Chronikeintrag konnte nicht gespeichert werden.");}
    }:null});
  return {revoke:resetJob,scope};
}

module.exports={registerCustomerAccess,mergePortalTasks};

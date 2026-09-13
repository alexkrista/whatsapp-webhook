"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { sanitizeCustomerPortal } = require("./customer-portal");
const { createAliasResolver } = require("./job-renumber");
const { dedupeReports } = require("./public/ui/regie-billing-state");
const safeId = id => /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ""));
const hash = text => crypto.createHash("sha256").update(String(text)).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { if(e.code === "ENOENT") return fallback; throw e; } };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); const tmp=file+"."+crypto.randomUUID()+".tmp"; try { fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600}); fs.renameSync(tmp,file); } finally { fs.rmSync(tmp,{force:true}); } };
const clean = (value, max=500) => String(value || "").trim().slice(0,max);
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
  async function catalog(ctx) {
    const files=new Map(),projects=[],reports=[],materials=[];
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
        for(const row of meta.surfaceMaterialMeta||[])if(row.relevant)materials.push({jobId,name:clean(row.name),quantity:Number(row.quantity)||0,unit:clean(row.unit,30),use:clean(row.use)});
      }
      if(ctx.portal.modules.regie)for(const row of dedupeReports(documents.filter(row=>row.type==="regie_report"))) {
        const physical=row.storedName&&path.basename(row.storedName)===row.storedName&&/\.pdf$/i.test(row.storedName)?secureFile(jobId,"_documentation/"+row.storedName):null;
        const url=add(jobId,"pdf",row.reportNumber||row.name||"Regiebericht",physical,"regie",row.reportDate||"");
        reports.push({jobId,id:clean(row.id,100),number:clean(row.reportNumber||row.name,120),date:clean(row.reportDate,10),hours:Number(row.totalHours)||0,net:Number(row.totalNet)||0,description:clean(row.description,12000),employees:clean(row.employees,1000),materials:(row.materials||[]).map(m=>({name:clean(m.name),quantity:Number(m.quantity)||0,unit:clean(m.unit,30)})),url});
      }
    }
    return {files,projects,reports,materials};
  }
  function pointRows(ctx) {
    const folder=path.join(dataDir,ctx.jobId,"_customer-portal"),rows=fs.existsSync(folder)?fs.readdirSync(folder).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).map(name=>read(path.join(folder,name),null)).filter(Boolean):[];
    const tasks=read(path.join(dataDir,"_kristine/tasks.json"),[]);
    return rows.filter(row=>row.contact===ctx.grant.contact&&ctx.portal.modules[row.module]).map(row=>({id:row.id,module:row.module,text:row.text,area:row.area,date:row.date,status:tasks.find(task=>task.id===row.taskId)?.status==="done"?"done":"open"}));
  }
  app.get("/kundenportal/api/project",guard(async(req,res)=>{
    const ctx=await context(req),data=await catalog(ctx);
    res.json({ok:true,name:ctx.meta.name,customerName:ctx.portal.customerName,number:ctx.label,mainJobId:ctx.jobId,modules:ctx.portal.modules,csrf:ctx.session.csrf,preview:!!ctx.grant.preview,projects:data.projects,reports:data.reports,materials:data.materials,files:[...data.files.values()].map(({physical,...row})=>row),points:pointRows(ctx)});
  }));
  app.get("/kundenportal/api/file/:jobId/:id",guard(async(req,res)=>{
    const ctx=await context(req);
    if(!ctx.jobIds.includes(req.params.jobId))throw fail(404,"Datei nicht freigegeben.");
    const data=await catalog({...ctx,jobIds:[req.params.jobId]}),file=data.files.get(req.params.id);
    if(!file)throw fail(404,"Datei nicht freigegeben.");
    res.sendFile(file.physical,{headers:{"Cache-Control":"private, no-store"}});
  }));
  app.post("/kundenportal/api/point",guard(async(req,res)=>{
    sameOrigin(req);const ctx=await context(req);if(req.headers["x-csrf-token"]!==ctx.session.csrf||ctx.grant.preview)throw fail(403,"Diese Aktion ist nicht erlaubt.");
    const module=req.body?.module;if(!["communication","projectPoints"].includes(module)||!ctx.portal.modules[module])throw fail(403,"Dieser Bereich ist nicht freigegeben.");
    const text=clean(req.body?.text,5000),area=clean(req.body?.area,140);if(!text)throw fail(400,"Bitte eine Nachricht eingeben.");
    const id=crypto.randomUUID(),taskId="customer_"+id,date=new Date(now()).toISOString();
    const employees=typeof readEmployees==="function"?await readEmployees():[],owner=employees.find(row=>/^alexander krista$/i.test(row.name||""));
    const task={id:taskId,title:(module==="communication"?"Kundennachricht":"Kundenpunkt prüfen")+" · "+ctx.meta.name+" · "+(area||text).slice(0,70),jobId:ctx.jobId,jobName:ctx.meta.name,assigneeId:owner?.id||"admin",assigneeName:owner?.name||"Alexander Krista",taskType:"Sonstiges",priority:"normal",creatorId:"customer-portal",creatorName:ctx.portal.customerName||ctx.meta.name,contactName:ctx.portal.customerName,contactPhone:ctx.portal.customerPhone,contactEmail:ctx.portal.customerEmail,reminder:text.slice(0,500),status:"open",createdAt:date,completedAt:null};
    write(path.join(dataDir,ctx.jobId,"_customer-portal",id+".json"),{id,taskId,module,text,area,date,contact:ctx.grant.contact});
    write(path.join(dataDir,"_kristine/customer-portal-tasks",id+".json"),task);
    res.status(201).json({ok:true,id});
  }));
  return {revoke:resetJob,scope};
}

module.exports={registerCustomerAccess,mergePortalTasks};

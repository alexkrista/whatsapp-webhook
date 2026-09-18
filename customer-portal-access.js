"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), QRCode = require("qrcode");
const { sanitizeCustomerPortal } = require("./customer-portal");
const { createAliasResolver } = require("./job-renumber");
const { dedupeReports } = require("./public/ui/regie-billing-state");
const { readMaterialSources, collectCustomerMaterials } = require("./customer-portal-materials");
const { readCustomerInvoices, invoiceView } = require("./customer-portal-invoices");
const { registerCustomerExports } = require("./customer-portal-export");
const { pointTitle, customerPointView } = require("./customer-portal-points");
const { OFFER_TERMS } = require("./offer-terms");
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
  const {dataDir,requireAdmin,readJobMeta,writeJobMeta,appendJobHistory,collectionMembers,readDocumentation,writeDocumentation,listJobMedia,readEmployees}=options;
  const root=path.join(dataDir,"_system/customer-access"), origin=new URL(options.publicBaseUrl || "https://protokoll.krista.at").origin;
  const now=options.now || Date.now, aliases=createAliasResolver(dataDir);
  const grantPath=id=>path.join(root,"invitations",id+".json");
  const sessionPath=value=>path.join(root,"sessions",hash(value)+".json");
  const offerPath=jobId=>path.join(dataDir,jobId,".offer-draft.json");
  const offerSnapshotPath=(jobId,number,revision)=>path.join(dataDir,jobId,"_offers",`offer-${number}-v${revision}.json`);
  const offerPdfName=(number,revision)=>`angebot-${String(number).replace(/[^A-Za-z0-9_-]/g,"")}-v${Math.max(1,Number(revision)||1)}.pdf`;
  const offerPdfSnapshotPath=(jobId,number,revision)=>path.join(dataDir,jobId,"_offers",offerPdfName(number,revision));
  const offerPdfManifestPath=(jobId,number,revision)=>offerPdfSnapshotPath(jobId,number,revision)+".json";
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
    res.setHeader("Cache-Control","private, no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");next();
  });
  app.get("/kundenportal",(_req,res)=>res.sendFile(path.join(options.publicDir,"kundenportal.html")));
  app.get("/kundenportal/assets/:name",(req,res)=>{
    if(!["kundenportal.js","kundenportal.css"].includes(req.params.name))return res.sendStatus(404);
    res.sendFile(path.join(options.publicDir,"ui",req.params.name));
  });
  app.post("/admin/api/job/:jobId/customer-portal/invitation",guard(async(req,res)=>{
    if(!requireAdmin(req,res))return;
    const jobId=await mainId(req.params.jobId),purpose=req.body?.purpose==="offer"?"offer":"portal";
    if(purpose==="offer"){
      const meta=await readJobMeta(jobId),draft=read(offerPath(jobId),null),offerNumber=clean(req.body?.offerNumber,20),offerRevision=Math.max(1,Number(req.body?.offerRevision)||1);
      if(!draft||draft.offerNumber!==offerNumber||Number(draft.offerRevision||1)!==offerRevision)throw fail(409,"Das Angebot wurde inzwischen geändert. Bitte die Druckansicht neu erzeugen.");
      const snapshot=offerSnapshotPath(jobId,offerNumber,offerRevision);if(!read(snapshot,null))write(snapshot,draft);
      const before=sanitizeCustomerPortal(meta.customerPortal),portal=sanitizeCustomerPortal({...before,status:before.status==="active"?"active":"prepared",modules:{...before.modules,projectFile:true}},before);
      if(typeof writeJobMeta!=="function")throw fail(503,"Kundenportal kann derzeit nicht vorbereitet werden.");
      await writeJobMeta(jobId,{customerPortal:{...portal,updatedAt:new Date(now()).toISOString()}});
    }
    const current=await scope(jobId);
    if(!Object.values(current.portal.modules).some(Boolean))throw fail(400,"Bitte mindestens einen Bereich freigeben.");
    const id=crypto.randomBytes(16).toString("hex"),secret=random(),preview=req.body?.preview===true,offerNumber=purpose==="offer"?clean(req.body?.offerNumber,20):"",offerRevision=purpose==="offer"?Math.max(1,Number(req.body?.offerRevision)||1):0;
    const grant={id,jobId:current.jobId,jobIds:current.jobIds,contact:fingerprint(current.portal),secretHash:hash(secret),createdAt:now(),expiresAt:now()+(preview?600000:purpose==="offer"?90*86400000:7*86400000),preview,purpose,offerNumber,offerRevision};
    write(grantPath(id),grant);
    // Secrets stay in the fragment: neither access logs nor referrers receive it.
    const portalUrl=origin+"/kundenportal#zugang="+id+"."+secret,qrSvg=purpose==="offer"?await QRCode.toString(portalUrl,{type:"svg",errorCorrectionLevel:"M",margin:1,width:220,color:{dark:"#17211b",light:"#ffffff"}}):"";
    res.setHeader("Cache-Control","no-store");res.json({ok:true,portalUrl,qrSvg,expiresAt:new Date(grant.expiresAt).toISOString(),jobId:current.jobId,purpose,offerNumber,offerRevision});
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
        const visibleDocuments=documents.filter(row=>row.customerVisible===true&&row.type!=="regie_report"),seenOffers=new Set();
        for(const row of visibleDocuments){
          if(row.type==="offer"){
            const offerKey=`${clean(row.offerNumber,20)||clean(row.name,180)}|${Math.max(1,Number(row.offerRevision)||1)}`;
            if(seenOffers.has(offerKey))continue;
            seenOffers.add(offerKey);
          }
          if(row.storedName&&path.basename(row.storedName)===row.storedName&&/\.pdf$/i.test(row.storedName))add(jobId,"pdf",row.name||"Dokument",secureFile(jobId,"_documentation/"+row.storedName),"documents");
        }
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
    return rows.map(row=>{const point=customerPointView(row,tasks.get(row.taskId)),internalPhotos=(row.photos||[]).filter(photo=>photo?.internal===true&&/^[a-f0-9-]{36}$/.test(photo.id||""));return{...point,photos:[...point.photos,...internalPhotos.map(photo=>({id:photo.id,name:clean(photo.name,180)||"Foto",type:clean(photo.type,80),internal:true}))],internalPhotoCount:internalPhotos.length}}).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  }
  function pointPhotos(value,jobId,pointId,internal=false) {
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
      return {id,name:clean(row?.name,180)||"Foto",type:match[1],file:relative.replace(/\\/g,"/"),internal:internal===true};
    });
  }
  async function createPoint({jobId,meta,portal,contact,source,creatorName,body}) {
    const module=body?.module;if(!["communication","projectPoints"].includes(module))throw fail(400,"Ungültiger Bereich.");
    const text=clean(body?.text,5000),area=clean(body?.area,140),title=pointTitle({title:clean(body?.title,140),text,area});if(!text)throw fail(400,"Bitte eine Nachricht eingeben.");
    const responsibility=body?.responsibility==="bauherr"?"bauherr":"krista",id=crypto.randomUUID(),taskId="customer_"+id,date=new Date(now()).toISOString();
    const photosInternal=source==="office"&&body?.photosInternal===true;
    let photos=[];try{photos=pointPhotos(body?.photos,jobId,id,photosInternal)}catch(error){fs.rmSync(path.join(dataDir,jobId,"_customer-portal","_files",id),{recursive:true,force:true});throw error}
    const employees=typeof readEmployees==="function"?await readEmployees():[],owner=employees.find(row=>/^alexander krista$/i.test(row.name||""));
    const task={id:taskId,title:(module==="communication"?"Kundennachricht":"Kundenpunkt prüfen")+" · "+meta.name+" · "+title.slice(0,70),jobId,jobName:meta.name,assigneeId:owner?.id||"admin",assigneeName:owner?.name||"Alexander Krista",taskType:"Sonstiges",priority:"normal",creatorId:source==="office"?"krista-office":"customer-portal",creatorName:creatorName||portal.customerName||meta.name,contactName:portal.customerName,contactPhone:portal.customerPhone,contactEmail:portal.customerEmail,customerResponsibility:responsibility,reminder:text.slice(0,500),status:"open",createdAt:date,completedAt:null};
    write(path.join(dataDir,jobId,"_customer-portal",id+".json"),{id,taskId,module,title,text,area,responsibility,photos,date,contact,source,history:[{kind:"submitted",status:"open",date}]});
    write(path.join(dataDir,"_kristine/customer-portal-tasks",id+".json"),task);
    const point=customerPointView({id,taskId,module,title,text,area,responsibility,photos,date,history:[{kind:"submitted",status:"open",date}]},task);
    return source==="office"?{...point,photos:photos.map(photo=>({id:photo.id,name:photo.name,type:photo.type,internal:photo.internal===true})),internalPhotoCount:photos.filter(photo=>photo.internal===true).length}:point;
  }
  function customerOffer(ctx) {
    const current=read(offerPath(ctx.jobId),null),isOfferGrant=ctx.grant.purpose==="offer",wantedNumber=isOfferGrant?clean(ctx.grant.offerNumber,20):clean(current?.offerNumber,20),wantedRevision=isOfferGrant?Math.max(1,Number(ctx.grant.offerRevision)||1):Math.max(1,Number(current?.offerRevision)||1);
    if(!wantedNumber)return null;
    const snapshot=read(offerSnapshotPath(ctx.jobId,wantedNumber,wantedRevision),null),draft=snapshot||(isOfferGrant?current:null);
    // Normale Portalzugänge sehen ausschließlich eine bereits finalisierte
    // Angebotsfassung. Ein noch nicht gedruckter Entwurf bleibt intern.
    if(!draft)return null;
    if(!draft||draft.offerNumber!==wantedNumber||Number(draft.offerRevision||1)!==wantedRevision)return{available:false,number:wantedNumber,revision:wantedRevision,message:"Dieses Angebot wurde inzwischen überarbeitet. Bitte fordern Sie die aktuelle Fassung bei Farben Krista an."};
    const positions=(Array.isArray(draft.positions)?draft.positions:[]).filter(row=>row?.isAlternative!==true&&Number(row?.quantity)>0).map(row=>({text:clean(row.text,1000),quantity:Math.max(0,Number(row.quantity)||0),unit:clean(row.unit,20),unitPrice:Math.max(0,Number(row.unitPrice)||0),groupName:clean(row.groupName,160)}));
    const base=positions.reduce((sum,row)=>sum+row.quantity*row.unitPrice,0),discounts=draft.groupDiscounts&&typeof draft.groupDiscounts==="object"?draft.groupDiscounts:{},groups=[...new Set(positions.map(row=>row.groupName).filter(Boolean))],groupDiscount=groups.reduce((sum,group)=>{const subtotal=positions.filter(row=>row.groupName===group).reduce((value,row)=>value+row.quantity*row.unitPrice,0);return sum+subtotal*Math.max(0,Math.min(100,Number(discounts[group])||0))/100},0),finance=draft.financials||{},afterGroups=Math.max(0,base-groupDiscount),globalDiscount=afterGroups*Math.max(0,Math.min(100,Number(finance.discountPercent)||0))/100,after=Math.max(0,afterGroups-globalDiscount),vatRate=Math.max(0,Math.min(100,Number(finance.vatRate??20)||0)),net=finance.priceMode==="gross"?after/(1+vatRate/100):after,vat=finance.priceMode==="gross"?after-net:net*vatRate/100,gross=finance.priceMode==="gross"?after:net+vat,acceptance=draft.customerAcceptance?.offerNumber===draft.offerNumber&&Number(draft.customerAcceptance?.offerRevision)===Number(draft.offerRevision)?draft.customerAcceptance:null;
    const createdAt=draft.offerCreatedAt||draft.updatedAt||"",validUntil=Number.isFinite(Date.parse(createdAt))?new Date(Date.parse(createdAt)+30*86400000).toISOString():"";
    return{available:true,number:draft.offerNumber,revision:Number(draft.offerRevision||1),createdAt,validUntil,intro:clean(draft.intro,1000),scopeDescription:clean(draft.scopeDescription,2000),positions,totals:{base,groupDiscount,globalDiscount,net,vat,vatRate,gross},terms:OFFER_TERMS,acceptance:acceptance?{status:"accepted",acceptedAt:acceptance.acceptedAt,customerName:acceptance.customerName,paymentTerm:acceptance.paymentTerm,paymentLabel:acceptance.paymentLabel,preferredDate:acceptance.preferredDate||"",termsVersion:acceptance.termsVersion||"",termsAcceptedAt:acceptance.termsAcceptedAt||acceptance.acceptedAt}:null};
  }
  async function ensureOfferPdf(ctx,offer) {
    if(!offer?.available||typeof readDocumentation!=="function"||typeof writeDocumentation!=="function")return null;
    const storedName=offerPdfName(offer.number,offer.revision),rows=await readDocumentation(ctx.jobId),matching=rows.filter(row=>row?.type==="offer"&&(row?.storedName===storedName||row?.offerNumber===offer.number&&Number(row?.offerRevision||1)===offer.revision));
    const snapshot=secureFile(ctx.jobId,"_offers/"+storedName);
    const approvedSources=new Set(["offer-approved-original","offer-approved-correction","offer-browser-render"]),manifest=read(offerPdfManifestPath(ctx.jobId,offer.number,offer.revision),null);
    if(snapshot&&approvedSources.has(manifest?.source))return{type:"offer",storedName,offerNumber:offer.number,offerRevision:offer.revision,customerVisible:true,source:manifest.source,storage:"offers"};
    const exact=matching.find(row=>row.customerVisible===true&&approvedSources.has(row.source)&&row.storedName&&secureFile(ctx.jobId,"_documentation/"+row.storedName));
    const source=exact&&secureFile(ctx.jobId,"_documentation/"+exact.storedName);
    // Die beim Versand verwendete PDF wird unveränderlich in _offers gesichert.
    // Ein verlorener Dokumentenindex darf sie niemals aus dem Portal entfernen.
    if(source){const target=offerPdfSnapshotPath(ctx.jobId,offer.number,offer.revision);fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.copyFileSync(source,target);write(offerPdfManifestPath(ctx.jobId,offer.number,offer.revision),{offerNumber:offer.number,offerRevision:offer.revision,storedName,source:exact.source,approvedAt:exact.approvedAt||exact.importedAt||new Date(now()).toISOString()});return{...(exact||{}),type:"offer",storedName,offerNumber:offer.number,offerRevision:offer.revision,customerVisible:true,source:exact.source,storage:"offers"}}
    return null;
  }
  app.get("/kundenportal/api/project",guard(async(req,res)=>{
    const ctx=await context(req),offer=customerOffer(ctx),offerPdf=await ensureOfferPdf(ctx,offer),data=await catalog(ctx);
    const billing = ctx.portal.modules.projectFile ? await readCustomerInvoices(dataDir, await Promise.all(ctx.jobIds.map(async jobId=>({...await readJobMeta(jobId),jobId})))) : {entries:[],complete:true,unavailable:[],syncedAt:null};
    res.json({ok:true,name:ctx.meta.name,customerName:ctx.portal.customerName,number:ctx.label,mainJobId:ctx.jobId,modules:ctx.portal.modules,csrf:ctx.session.csrf,preview:!!ctx.grant.preview,offer:offer?{...offer,pdfUrl:offerPdf?"/kundenportal/api/offer/pdf":""}:offer,projects:data.projects,reports:data.reports,regieSummary:data.regieSummary,materials:data.materials,materialStatus:data.materialStatus,invoices:billing.entries.map(entry=>invoiceView(entry,!!options.readInvoicePdf)),invoiceStatus:{complete:billing.complete,unavailable:billing.unavailable,syncedAt:billing.syncedAt},files:[...data.files.values()].map(({physical,...row})=>row),points:pointRows(ctx)});
  }));
  app.get("/kundenportal/api/offer/pdf",guard(async(req,res)=>{
    const ctx=await context(req),offer=customerOffer(ctx),item=await ensureOfferPdf(ctx,offer),file=item&&secureFile(ctx.jobId,(item.storage==="offers"?"_offers/":"_documentation/")+item.storedName);if(!file)throw fail(404,"Angebots-PDF nicht verfügbar.");
    // Only this authenticated PDF may be framed by the customer portal itself.
    // The general portal keeps frame-ancestors 'none' against third-party embedding.
    res.setHeader("Content-Security-Policy","default-src 'none'; frame-ancestors 'self'");
    res.type("application/pdf").setHeader("Content-Disposition",`inline; filename="Angebot-${String(offer.number).replace(/[^A-Za-z0-9_-]/g,"")}.pdf"`);res.sendFile(file,{headers:{"Cache-Control":"private, no-store"}});
  }));
  app.post("/kundenportal/api/offer/accept",guard(async(req,res)=>{
    sameOrigin(req);const ctx=await context(req);if(req.headers["x-csrf-token"]!==ctx.session.csrf||ctx.grant.preview)throw fail(403,"Diese Aktion ist nicht erlaubt.");
    const offer=customerOffer(ctx);if(!offer?.available)throw fail(409,offer?.message||"Dieses Angebot ist nicht mehr verfügbar.");
    if(!await ensureOfferPdf(ctx,offer))throw fail(409,"Die verbindliche Angebots-PDF fehlt. Bitte Farben Krista kontaktieren; der Auftrag wurde noch nicht bestätigt.");
    const file=offerSnapshotPath(ctx.jobId,offer.number,offer.revision),draft=read(file,null);if(!draft)throw fail(409,"Die verbindliche Angebotsfassung ist nicht mehr verfügbar.");if(draft.customerAcceptance?.offerNumber===offer.number&&Number(draft.customerAcceptance?.offerRevision)===offer.revision)return res.json({ok:true,acceptance:draft.customerAcceptance,alreadyAccepted:true});
    if(req.body?.confirmed!==true)throw fail(400,"Bitte bestätigen Sie die verbindliche Beauftragung.");
    if(req.body?.termsAccepted!==true||clean(req.body?.termsVersion,40)!==OFFER_TERMS.version)throw fail(400,"Bitte bestätigen Sie die aktuelle Fassung der AGB.");
    const paymentLabels={net14:"14 Tage netto",skonto5_2:"2 % Skonto bei Zahlung binnen 5 Tagen",deposit50:"4 % Skonto bei 50 % Anzahlung, fällig bei Auftragserteilung"},paymentTerm=clean(req.body?.paymentTerm,30),paymentLabel=paymentLabels[paymentTerm];if(!paymentLabel)throw fail(400,"Bitte wählen Sie eine Zahlungsbedingung.");
    const preferredDate=clean(req.body?.preferredDate,10);if(preferredDate&&!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate))throw fail(400,"Bitte einen gültigen Wunschtermin wählen.");
    const acceptedAt=new Date(now()).toISOString(),acceptance={status:"accepted",acceptedAt,offerNumber:offer.number,offerRevision:offer.revision,customerName:ctx.portal.customerName||ctx.meta.name,grantId:ctx.grant.id,paymentTerm,paymentLabel,preferredDate,termsVersion:OFFER_TERMS.version,termsAcceptedAt:acceptedAt};draft.customerAcceptance=acceptance;write(file,draft);const current=read(offerPath(ctx.jobId),null);if(current?.offerNumber===offer.number&&Number(current.offerRevision||1)===offer.revision){current.customerAcceptance=acceptance;write(offerPath(ctx.jobId),current)}
    if(typeof writeJobMeta==="function")await writeJobMeta(ctx.jobId,{status:"Auftrag"});
    if(typeof appendJobHistory==="function")await appendJobHistory(ctx.jobId,{type:"offer_customer_accepted",title:`Angebot ${offer.number} verbindlich beauftragt`,detail:`${acceptance.customerName} · ${paymentLabel}${preferredDate?` · Wunschtermin ${preferredDate}`:""}`,source:"Kundenportal",data:{offerNumber:offer.number,offerRevision:offer.revision,acceptedAt,paymentTerm,paymentLabel,preferredDate,termsAcceptedAt:acceptedAt}});
    res.json({ok:true,acceptance});
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
    const photo=(point.photos||[]).find(row=>row.id===req.params.photoId&&row.internal!==true),file=photo&&secureFile(ctx.jobId,photo.file);
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
    const module=req.body?.module,offerQuestion=module==="communication"&&req.body?.offerQuestion===true&&customerOffer(ctx)?.available;if(!["communication","projectPoints"].includes(module)||(!ctx.portal.modules[module]&&!offerQuestion))throw fail(403,"Dieser Bereich ist nicht freigegeben.");
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

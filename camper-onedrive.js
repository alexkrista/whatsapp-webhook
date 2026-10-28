'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const GRAPH='https://graph.microsoft.com/v1.0',LOCAL_LIMIT=10*1024*1024;
const enc=encodeURIComponent;
function createOneDrive(accessToken,request=fetch){
 async function graph(suffix,method='GET',body,stage='OneDrive-Anfrage'){
  if(!suffix.startsWith('/')||suffix.startsWith('//'))throw Error('Ungültiger OneDrive-Aufruf.');
  if(typeof accessToken!=='function')throw Object.assign(Error('OneDrive bitte zuerst mit Microsoft verbinden.'),{status:503});
  let r;try{r=await request(GRAPH+suffix,{method,headers:{Authorization:'Bearer '+await accessToken(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{throw Object.assign(Error('OneDrive ist derzeit nicht erreichbar. Bitte erneut versuchen.'),{status:503});}
  if(!r.ok){let graphCode='',graphMessage='';try{const data=await r.json();graphMessage=String(data.error?.message||'').replace(/[\x00-\x1f]/g,' ').replace(/https?:\/\/\S+/g,'[Microsoft-Link]').slice(0,300);graphCode=String(data.error?.code||'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80);}catch{}
 console.error('[Camper OneDrive] request_failed',{method,stage,operation:suffix.includes('createUploadSession')?'create_upload':suffix.endsWith('/children')?'create_folder':'read',status:r.status,code:graphCode,message:graphMessage});
 const error=Object.assign(Error(r.status===403?'OneDrive benötigt die Microsoft-Freigabe „Dateien lesen und schreiben“. Bitte „OneDrive verbinden“ wählen.':r.status===401?'Microsoft-Anmeldung abgelaufen. Bitte OneDrive neu verbinden.':r.status===404?'OneDrive oder die Datei wurde nicht gefunden.':r.status===507?'In OneDrive ist nicht genügend Speicher frei.':stage+' fehlgeschlagen (HTTP '+r.status+(graphCode?' · '+graphCode:'')+').'+(graphMessage?' '+graphMessage:'')),{status:r.status===404?404:503,graphStatus:r.status,graphCode});throw error;}
  return r.json();
 }
 async function children(driveId,parentId){
  const prefix='/drives/'+enc(driveId)+'/items/'+enc(parentId)+'/children';let next=prefix,items=[];
  for(let page=0;next&&page<100;page++){
   const data=await graph(next,'GET',undefined,'OneDrive-Ordnersuche');items.push(...(data.value||[]));next='';
   if(data['@odata.nextLink']){const url=new URL(data['@odata.nextLink']);if(url.origin!==new URL(GRAPH).origin||!url.pathname.startsWith('/v1.0'+prefix))throw Error('Ungültiger OneDrive-Fortsetzungslink.');next=url.pathname.slice('/v1.0'.length)+url.search;}
  }
  if(next)throw Error('OneDrive-Ordner enthält zu viele Einträge für die Suche.');return items;
 }
 async function folder(parts,baseFolder){
  const drive=baseFolder?{id:baseFolder.driveId}:await graph('/me/drive','GET',undefined,'OneDrive-Laufwerk');if(!drive.id)throw Error('OneDrive liefert keine Laufwerk-ID.');
  const base='/drives/'+enc(drive.id);let parent=baseFolder||await graph(base+'/root','GET',undefined,'OneDrive-Stammordner');
  for(const name of parts){
   const find=async()=>{const found=(await children(drive.id,parent.id)).find(item=>String(item.name||'').toLocaleLowerCase()===name.toLocaleLowerCase());if(found&&!found.folder)throw Error('Der OneDrive-Zielname ist bereits durch eine Datei belegt.');return found;};
   let item=await find();if(!item){try{item=await graph(base+'/items/'+enc(parent.id)+'/children','POST',{name,folder:{},'@microsoft.graph.conflictBehavior':'fail'},'OneDrive-Ordner anlegen');}catch(e){if(e.graphStatus!==409)throw e;item=await find();if(!item)throw e;}}
   if(!item.id||!item.folder)throw Error('OneDrive hat den Zielordner nicht bestätigt.');parent=item;
  }
  return {...parent,driveId:drive.id};
 }
 return {graph,folder,children};
}
function registerOneDrive(router,{store,dir,accessToken,fetch:request,wrap,assignment,modelUrl=value=>value||''}){
 const client=()=>createOneDrive(accessToken(),request||fetch),pending=path.join(dir,'cloud-uploads');
 const rootFile=path.join(dir,'onedrive-project-root.json');
 async function cachedRoot(){try{return JSON.parse(await fs.readFile(rootFile,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function projectRoot(c){const stored=await cachedRoot();if(stored?.id&&stored.driveId){try{const item=await c.graph('/drives/'+enc(stored.driveId)+'/items/'+enc(stored.id),'GET',undefined,'OneDrive-Projektordner prüfen');if(item.folder)return {...item,driveId:stored.driveId};}catch(e){if(e.graphStatus!==404)throw e;}}
  const root=await c.folder(['Camperwerkstatt']);await fs.mkdir(dir,{recursive:true});const tmp=rootFile+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify({id:root.id,driveId:root.driveId,webUrl:root.webUrl||'',name:'Camperwerkstatt'}),{mode:0o600});await fs.rename(tmp,rootFile);return root;
 }
 router.post('/api/onedrive/prepare',wrap(async(req,res)=>{if(!req.camperActor.admin)return res.sendStatus(403);const c=client(),root=await projectRoot(c);for(const name of ['Egon','Elio','Beide Camper'])await c.folder([name],root);res.json({ready:true,folder:'Camperwerkstatt',webUrl:root.webUrl||'',folders:['Egon','Elio','Beide Camper']});}));
 const validId=id=>{if(!/^[a-f0-9-]{36}$/i.test(id||''))throw Error('Uploadkennung ungültig.');return id;};
 async function session(id,actor){const p=JSON.parse(await fs.readFile(path.join(pending,validId(id)+'.json'),'utf8').catch(e=>{if(e.code==='ENOENT')throw Error('Upload nicht gefunden. Bitte die Datei erneut auswählen.');throw e;}));if(p.owner!==actor.id&&!actor.admin)throw Object.assign(Error('Kein Zugriff auf diesen Upload.'),{status:403});return p;}
 router.get('/api/onedrive/status',wrap(async(req,res)=>{try{const d=await client().graph('/me/drive','GET',undefined,'OneDrive-Laufwerk');const root=await cachedRoot();res.json({connected:true,folder:'Camperwerkstatt',folderReady:!!root,webUrl:root?.webUrl||'',localLimit:LOCAL_LIMIT});}catch(e){res.json({connected:false,error:e.message,localLimit:LOCAL_LIMIT});}}));
 router.post('/api/onedrive/uploads',wrap(async(req,res)=>{
  const b=req.body,size=Number(b.size),name=String(b.name||'').trim();if(!name||name.length>180||/[\\/\x00-\x1f]/.test(name)||!Number.isSafeInteger(size)||size<=LOCAL_LIMIT||size>250*1024**3)throw Error('Dateiname oder Dateigröße ungültig. OneDrive wird für Dateien über 10 MB verwendet.');
  const allowed=/\.(jpg|jpeg|png|webp|pdf|skp|eml|mp4|webm|mov|zip)$/i;if(!allowed.test(name))throw Error('Dieser Dateityp ist nicht unterstützt.');
  const a=assignment(b,await store.read()),model=modelUrl(b.modelUrl),c=client(),id=crypto.randomUUID(),safeName=id+'-'+name.replace(/["*:<>?\|#%]/g,'_');
  const labels={egon:'Egon',elio:'Elio',both:'Beide Camper'},categories={plan:'Pläne',angebot:'Angebote',rechnung:'Rechnungen',idee:'Ideen',mail:'Mails',sonstiges:'Sonstiges'};
  const root=await projectRoot(c),target=await c.folder([labels[a.vehicle],categories[a.category]||'Sonstiges'],root);
  const upload=await c.graph('/drives/'+enc(target.driveId)+'/items/'+enc(target.id)+':/'+enc(safeName)+':/createUploadSession','POST',{},'OneDrive-Upload starten');
  if(!upload.uploadUrl||!/^https:\/\//i.test(upload.uploadUrl))throw Error('OneDrive hat keinen gültigen Upload bereitgestellt.');
  const p={id,owner:req.camperActor.id,name,size,...a,folderId:target.id,driveId:target.driveId,storedName:safeName,versionLabel:String(b.version||'').slice(0,80),modelUrl:model,uploadUrl:upload.uploadUrl,expires:upload.expirationDateTime,created:new Date().toISOString(),by:req.camperActor.name};
  await fs.mkdir(pending,{recursive:true});await fs.writeFile(path.join(pending,id+'.json'),JSON.stringify(p),{flag:'wx',mode:0o600});
  res.status(201).json({id,uploadUrl:p.uploadUrl,expires:p.expires});
 }));
 router.post('/api/onedrive/uploads/:id/complete',wrap(async(req,res)=>{
  const p=await session(req.params.id,req.camperActor),c=client(),driveId=p.driveId||(await c.graph('/me/drive')).id;
  let item;if(req.body?.itemId){const itemId=String(req.body.itemId);if(itemId.length>512||/[\x00-\x1f]/.test(itemId))throw Error('Ungültige OneDrive-Dateikennung.');item=await c.graph('/drives/'+enc(driveId)+'/items/'+enc(itemId),'GET',undefined,'OneDrive-Datei bestätigen');}
  else item=(await c.children(driveId,p.folderId)).find(f=>f.name===p.storedName);

  if(!item?.file||item.name!==p.storedName||Number(item.size)!==p.size||item.parentReference?.id!==p.folderId)throw Error('Der OneDrive-Upload ist noch nicht vollständig. Bitte erneut versuchen.');
  res.json(await store.update(s=>{if(s.files.some(f=>f.id===p.id))return;const a=assignment(p,s),now=new Date().toISOString();s.files.push({id:p.id,name:p.name,size:p.size,type:String(item.file.mimeType||'application/octet-stream'),storage:'onedrive',driveId:String(driveId),itemId:String(item.id),webUrl:String(item.webUrl||''),...a,version:1,versionLabel:p.versionLabel,modelUrl:p.modelUrl,created:now,by:p.by});if(a.category==='idee')s.ideas.push({id:crypto.randomUUID(),fileId:p.id,title:p.name,vehicle:a.vehicle,version:1,url:'',imageUrl:'',topic:'',notes:'',created:now,by:p.by});}));
 }));
 router.get('/api/files/:id/cloud-thumbnail',wrap(async(req,res)=>{
  const f=(await store.read()).files.find(f=>f.id===req.params.id&&f.storage==='onedrive');if(!f)return res.sendStatus(404);
  const data=await client().graph('/drives/'+enc(f.driveId)+'/items/'+enc(f.itemId)+'/thumbnails');const url=data.value?.[0]?.medium?.url||data.value?.[0]?.small?.url;if(!url||!/^https:\/\//i.test(url))return res.sendStatus(404);res.set('Referrer-Policy','no-referrer');res.redirect(302,url);
 }));
 async function download(f,res){const item=await client().graph('/drives/'+enc(f.driveId)+'/items/'+enc(f.itemId));const url=item['@microsoft.graph.downloadUrl'];if(!url||!/^https:\/\//i.test(url))throw Error('OneDrive stellt gerade keinen Download bereit. Bitte in OneDrive öffnen.');res.set('Referrer-Policy','no-referrer');res.redirect(302,url);}
 return {download};
}
module.exports={createOneDrive,registerOneDrive,LOCAL_LIMIT};

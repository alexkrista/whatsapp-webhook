"use strict";
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const queues=new Map();
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}};
const write=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file)};
const minutes=value=>{const m=String(value||'').match(/^(\d{2}):(\d{2})$/);return m&&+m[1]<24&&+m[2]<60?+m[1]*60 + +m[2]:null};
function suggestJob(photo,events){
 const at=minutes(photo.capturedAt)??minutes(photo.at);if(at===null)return {jobId:'',reason:'Keine eindeutige Fotozeit'};
 const rows=events.filter(e=>String(e.employeeId)===String(photo.employeeId)&&e.date===photo.date&&minutes(e.at)!==null&&minutes(e.at)<=at).sort((a,b)=>minutes(a.at)-minutes(b.at));
 if(!rows.length)return {jobId:'',reason:'Keine Stempelung zur Fotozeit'};
 const lastMinute=minutes(rows.at(-1).at),latest=rows.filter(e=>minutes(e.at)===lastMinute);
 if(new Set(latest.map(e=>e.type+'|'+(e.jobId||''))).size>1)return {jobId:'',reason:'Mehrdeutige Stempelung zur Fotozeit'};
 const last=latest.at(-1);if(!['start','weiter'].includes(last.type)||!last.jobId)return {jobId:'',reason:'Zur Fotozeit nicht auf einer Baustelle eingestempelt'};
 return {jobId:String(last.jobId),jobName:last.jobName||String(last.jobId),reason:'Stempelung um '+last.at};
}
function createPhotoInbox(dataDir){
 const root=path.join(dataDir,'_kristine'),file=path.join(root,'photo-inbox.json'),startedAt=new Date().toISOString();
 const serial=fn=>{const run=(queues.get(dataDir)||Promise.resolve()).then(fn);queues.set(dataDir,run.catch(()=>{}));return run};
 async function synchronize(){
  const [state,reviews,events]=await Promise.all([read(file,null),read(path.join(root,'day-review-entries.json'),[]),read(path.join(root,'time-events.json'),[])]);
  const data=state||{enabledAt:startedAt,items:{},seen:[]},seen=new Set(data.seen);let changed=!state;
  for(const photo of reviews){
   if(!photo.file||!['photo','video'].includes(photo.category)||photo.reportId||photo.lateUpload)continue;
   if(data.items[photo.file]||seen.has(photo.file))continue;
   seen.add(photo.file);changed=true;
   if(String(photo.createdAt||'')<data.enabledAt&&!photo.needsOfficeReview&&photo.jobId)continue;
   const groupId=crypto.createHash('sha256').update(String(photo.employeeId||'unknown')+'|'+photo.date).digest('hex').slice(0,24);
   data.items[photo.file]={...photo,groupId,status:'pending',suggestion:suggestJob(photo,events),originalJobId:photo.jobId||'',jobId:''};
  }
  for(const item of Object.values(data.items))if(item.status==='pending') {const suggestion=suggestJob(item,events);if(JSON.stringify(suggestion)!==JSON.stringify(item.suggestion)){item.suggestion=suggestion;changed=true}}
  data.seen=[...seen];if(changed)await write(file,data);
  await syncAssignments(data);await syncReviews(data);
  await syncTasks(data);return data;
 }
 async function syncAssignments(data){
  const target=path.join(root,'media-assignments.json'),assignments=await read(target,{});let changed=false;
  for(const [file,item] of Object.entries(data.items)){const previous=assignments[file];if(item.status!=='confirmed'||!previous||previous.inboxConfirmedAt===item.confirmedAt)continue;
   assignments[file]={...previous,jobId:item.jobId,updatedAt:item.confirmedAt,inboxConfirmedAt:item.confirmedAt,history:[...(previous.history||[]),{from:previous.jobId,to:item.jobId,at:item.confirmedAt}]};changed=true;
  }
  if(changed)await write(target,assignments);
 }
 async function syncReviews(data){
  const reviewFile=path.join(root,'day-review-entries.json'),reviews=await read(reviewFile,[]);let changed=false;
  for(const row of reviews){const item=data.items[row.file];if(!item)continue;
   if(item.retrospective&&item.status==='pending')continue;
   const assigned=item.status==='confirmed',jobId=assigned?item.jobId:null,status=assigned?'assigned':item.status==='dismissed'?'dismissed':'pending_confirmation';
   if(row.assignmentStatus!==status||String(row.jobId||'')!==String(jobId||'')){Object.assign(row,{jobId,jobName:assigned?item.jobId:'',assignmentStatus:status,needsOfficeReview:!assigned&&item.status!=='dismissed'});changed=true}
  }
  if(changed)await write(reviewFile,reviews);
 }
 async function syncTasks(data){
  const taskFile=path.join(root,'tasks.json'),tasks=await read(taskFile,[]),employees=await read(path.join(root,'employees.json'),[]),alex=employees.find(e=>/^alexander krista$/i.test(e.name||''))||employees.find(e=>/alex/i.test(e.name||''));
  const groups=new Map();for(const item of Object.values(data.items)){if(!groups.has(item.groupId))groups.set(item.groupId,[]);groups.get(item.groupId).push(item)}
  let changed=false;
  for(const [groupId,items] of groups){const pending=items.filter(x=>x.status==='pending'),id='photo_review_'+groupId,existing=tasks.find(t=>t.id===id),now=new Date().toISOString();
   if(!pending.length){if(existing&&existing.status!=='done'){Object.assign(existing,{status:'done',completedAt:now,updatedAt:now});changed=true}continue}
   const title='Fotos zuordnen · '+(items[0].employeeName||'Mitarbeiter offen')+' · '+items[0].date+' · '+pending.length+' Foto(s)/Video(s)';
   if(existing?.status==='open'&&existing.title===title)continue;
   const task={...(existing||{}),id,title,taskType:'Freigabe',priority:'heute',assigneeId:alex?.id||'admin',assigneeName:alex?.name||'Alexander Krista',dueDate:items[0].date,reminder:'[PHOTO_INBOX]groupId='+groupId,creatorId:'photo-inbox',creatorName:'KRISTINE Fotoeingang',status:'open',createdAt:existing?.createdAt||now,updatedAt:now,completedAt:null};
   if(existing)Object.assign(existing,task);else tasks.unshift(task);changed=true;
  }
  if(changed)await write(taskFile,tasks);
 }
 return {
  sync:()=>serial(synchronize),
  importHistory:()=>serial(async()=>{
   const data=await synchronize();if(data.historyImport?.completedAt)return data.historyImport;
   const [reviews,events,assignments]=await Promise.all([read(path.join(root,'day-review-entries.json'),[]),read(path.join(root,'time-events.json'),[]),read(path.join(root,'media-assignments.json'),{})]);
   const candidates=new Map(reviews.filter(r=>r.file&&['photo','video'].includes(r.category)).map(r=>[String(r.file).replace(/\\/g,'/'),r]));
   const {listJobMedia}=require('./media-migration');
   for(const dir of await fs.readdir(dataDir,{withFileTypes:true}))if(dir.isDirectory()&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(dir.name))for(const row of await listJobMedia({dataDir,jobId:dir.name}))candidates.set(row.file,{...candidates.get(row.file),...row,category:row.kind});
   const mediaRoot=path.join(root,'media');
   async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})){const full=path.join(dir,entry.name);if(entry.isDirectory()){await walk(full);continue}if(!entry.isFile()||! /\.(jpe?g|png|webp|gif|heic|mp4|mov|webm)$/i.test(entry.name))continue;const file=path.relative(dataDir,full).split(path.sep).join('/');if(candidates.has(file))continue;const parts=file.split('/'),stamp=Number(entry.name.match(/^(\d{10})_/)?.[1]);candidates.set(file,{file,id:'history_'+crypto.createHash('sha256').update(file).digest('hex').slice(0,20),employeeId:parts[3]||'',date:/^\d{4}-\d{2}-\d{2}$/.test(parts[2])?parts[2]:'',at:stamp?new Date(stamp*1000).toLocaleTimeString('de-AT',{timeZone:'Europe/Vienna',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}):'',category:/\.(mp4|mov|webm)$/i.test(entry.name)?'video':'photo',source:'Historischer Fotoordner'})}}
   await walk(mediaRoot);
   const employees=await read(path.join(root,'employees.json'),[]),result={added:0,reopened:0,alreadyPending:0,missing:[],scanned:candidates.size};
   for(const [file,photo] of candidates){const existing=data.items[file];const full=path.resolve(dataDir,file);if(!full.startsWith(path.resolve(dataDir)+path.sep)||!(await fs.stat(full).catch(()=>null))?.isFile()){result.missing.push(file);continue}if(existing?.status==='pending'){result.alreadyPending++;continue}
    const previousJobId=assignments[file]?.jobId||existing?.jobId||photo.jobId||'',first=file.split('/')[0],originalJobId=first!=='_kristine'?first:existing?.originalJobId||photo.jobId||previousJobId;
    const groupId=crypto.createHash('sha256').update(String(photo.employeeId||'unknown')+'|'+photo.date).digest('hex').slice(0,24);
    data.items[file]={...photo,employeeName:photo.employeeName||employees.find(e=>String(e.id)===String(photo.employeeId))?.name||'',groupId,status:'pending',retrospective:true,previousJobId,originalJobId,jobId:'',suggestion:suggestJob(photo,events),priorConfirmation:existing?.confirmedAt||null};
    if(existing)result.reopened++;else result.added++;
   }
   result.completedAt=new Date().toISOString();data.historyImport=result;await write(file,data);await syncTasks(data);return result;
  }),
  dismiss:(files,restore=false)=>serial(async()=>{
   const data=await synchronize();if(!Array.isArray(files)||!files.length||files.length>100)throw Error('Bitte 1 bis 100 Fotos wählen.');
   for(const file of files){const item=data.items[file];if(!item||!['pending','dismissed'].includes(item.status))throw Error('Foto nicht mehr im offenen Eingang.');}
   for(const file of files){const item=data.items[file];item.status=restore?'pending':'dismissed';item.dismissedAt=restore?null:new Date().toISOString();}
   await write(file,data);await syncReviews(data);await syncTasks(data);return files.length;
  }),
  confirm:changes=>serial(async()=>{const data=await synchronize();if(!Array.isArray(changes)||!changes.length||changes.length>100)throw Error('Bitte 1 bis 100 Fotos bestätigen.');
   for(const change of changes){if(!data.items[change.file]||data.items[change.file].status==='dismissed')throw Error('Foto nicht im Eingang.');if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(change.jobId||'')||!(await fs.stat(path.join(dataDir,change.jobId)).catch(()=>null))?.isDirectory())throw Error('Bitte für jedes Foto eine gültige Baustelle wählen.');if(data.items[change.file].status==='confirmed'&&data.items[change.file].jobId!==change.jobId)throw Error('Foto bereits bestätigt. Bitte in der Galerie ändern.')}
   for(const change of changes)Object.assign(data.items[change.file],{status:'confirmed',jobId:change.jobId,confirmedAt:data.items[change.file].confirmedAt||new Date().toISOString()});await write(file,data);await syncAssignments(data);await syncReviews(data);await syncTasks(data);return changes.length;
  })
 };
}
function registerPhotoInbox(app,{dataDir,requireAdmin}){
 const inbox=createPhotoInbox(dataDir);inbox.importHistory().catch(console.error);const timer=setInterval(()=>inbox.importHistory().catch(console.error),15000);timer.unref();
 app.get('/kristine/api/photo-inbox',async(req,res)=>{if(!requireAdmin(req,res))return;try{const state=await inbox.sync();res.json({ok:true,historyImport:state.historyImport||null,items:Object.values(state.items).filter(i=>i.status===(req.query.dismissed==='true'?'dismissed':'pending')).map(i=>({...i,url:'/kristine/api/photo-inbox/file?file='+encodeURIComponent(i.file)}))})}catch(e){res.status(500).json({ok:false,error:e.message})}});
 app.post('/kristine/api/photo-inbox/dismiss',async(req,res)=>{if(!requireAdmin(req,res))return;try{res.json({ok:true,count:await inbox.dismiss(req.body?.files,req.body?.restore===true)})}catch(e){res.status(400).json({ok:false,error:e.message})}});
 app.post('/kristine/api/photo-inbox/confirm',async(req,res)=>{if(!requireAdmin(req,res))return;try{res.json({ok:true,count:await inbox.confirm(req.body?.changes)})}catch(e){res.status(400).json({ok:false,error:e.message})}});
 app.get('/kristine/api/photo-inbox/file',async(req,res)=>{if(!requireAdmin(req,res))return;try{const state=await read(path.join(dataDir,'_kristine','photo-inbox.json'),{items:{}}),item=state.items[String(req.query.file||'')];if(!item)return res.status(404).send('Foto nicht gefunden');const full=path.resolve(dataDir,item.file),root=path.resolve(dataDir,'_kristine','media')+path.sep,originalRoot=/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.originalJobId||'')?path.resolve(dataDir,item.originalJobId)+path.sep:null;if(!full.startsWith(root)&&!(originalRoot&&full.startsWith(originalRoot)))return res.status(404).send('Foto nicht gefunden');res.setHeader('Cache-Control','private, no-store');res.sendFile(full)}catch(e){res.status(500).send(e.message)}});
 return inbox;
}
module.exports={createPhotoInbox,registerPhotoInbox,suggestJob};

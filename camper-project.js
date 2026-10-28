'use strict';
const fs=require('node:fs'), fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const cookie='camper_session';
const {pipeline}=require('node:stream/promises'),{Transform}=require('node:stream');
const MAX_FILE=10*1024*1024;
const empty=()=>({revision:0,budget:{egon:0,elio:0},tasks:[],costs:[],hours:[],decisions:[],files:[],mails:[],ideas:[],purchases:[]});
function createStore(dir){let queue=Promise.resolve();const file=path.join(dir,'project.json');return {async read(){try{return Object.assign(empty(),JSON.parse(await fsp.readFile(file,'utf8')));}catch(e){if(e.code==='ENOENT')return empty();throw e;}},update(fn){const op=queue.then(async()=>{const state=await this.read();await fn(state);state.revision++;await fsp.mkdir(dir,{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fsp.writeFile(tmp,JSON.stringify(state),{mode:0o600});await fsp.rename(tmp,file);return state;});queue=op.catch(()=>{});return op;}};}
function modelUrl(value){if(!value)return '';const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['app.sketchup.com','connect.trimble.com','web.connect.trimble.com','3dwarehouse.sketchup.com'].includes(u.hostname))throw Error('Bitte einen HTTPS-Link von SketchUp oder Trimble Connect verwenden.');return u.href;}

function webUrl(value){if(!value)return '';let u;try{u=new URL(String(value));}catch{throw Error('Bitte einen gültigen Link eingeben.');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Nur HTTP-/HTTPS-Links erlaubt.');return u.href.slice(0,2000);}
function details(kind,b,out){
 if(['tasks','decisions'].includes(kind)){
 const allowed=['task','appointment','decision','note'];out.types=Array.isArray(b.types)?[...new Set(b.types.filter(t=>allowed.includes(t)))]:[kind==='decisions'?'decision':'task'];
 if(!out.types.length)throw Error('Mindestens eine Eintragsart auswählen.');
 out.time=String(b.time||'').slice(0,5);
 if(out.types.includes('appointment')&&(!/^\d{4}-\d{2}-\d{2}$/.test(out.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time)))throw Error('Für Termine bitte Datum und Uhrzeit angeben.');
 for(const key of ['askedDate','dueEgon','dueElio','decidedEgon','decidedElio']){out[key]=String(b[key]||'').slice(0,10);if(out[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(out[key]))throw Error('Datum ungültig.');}
 for(const key of ['personEgon','personElio'])out[key]=String(b[key]||'').slice(0,80);
 for(const who of ['Egon','Elio'])out['choice'+who]=['ja','nein'].includes(b['choice'+who])?b['choice'+who]:'';
 for(const key of ['decisionStatusEgon','decisionStatusElio'])out[key]=['offen','entschieden','vertagt'].includes(b[key])?b[key]:'offen';
 out.answerEgon=String(b.answerEgon||'').slice(0,5000);out.answerElio=String(b.answerElio||'').slice(0,5000);
 out.sourceIdea=String(b.sourceIdea||'').slice(0,80);
 }
 if(kind==='ideas'){out.url=webUrl(b.url);out.imageUrl=webUrl(b.imageUrl);out.topic=String(b.topic||'').slice(0,80);out.fileId=String(b.fileId||'').slice(0,80);}
 if(kind==='purchases'){
 out.stage=['anfrage','angebot','bestellung','rechnung'].includes(b.stage)?b.stage:'anfrage';
 out.supplier=String(b.supplier||'').slice(0,160);
 out.amount=Number(b.amount||0);out.paidAmount=Number(b.paidAmount||0);
 if(!Number.isFinite(out.amount)||!Number.isFinite(out.paidAmount)||out.amount<0||out.amount>10000000||out.paidAmount<0||out.paidAmount>out.amount)throw Error('Betrag/Zahlung ungültig.');
 out.payment=out.paidAmount===0?'offen':out.paidAmount===out.amount?'bezahlt':'teilbezahlt';
 for(const key of ['invoiceDate','dueDate','paidDate'])out[key]=String(b[key]||'').slice(0,10);
 out.sourceIdea=String(b.sourceIdea||'').slice(0,80);
 }
 return out;
}


function stampDecision(kind,value,previous,actor,now=new Date().toISOString()){
 if(!['tasks','decisions'].includes(kind))return value;
 for(const who of ['Egon','Elio']){
 const key='answer'+who,before=String(previous?.[key]||''),choice=value['choice'+who]||'',oldChoice=previous?.['choice'+who]||'';let answer=String(value[key]||'');
 if(choice!==oldChoice&&choice&&(!answer||['Ja','Nein'].includes(answer))){answer=choice==='ja'?'Ja':'Nein';value[key]=answer;}
 if(choice!==oldChoice&&!choice&&oldChoice){answer='';value[key]='';}
 value['answeredAt'+who]=previous?.['answeredAt'+who]||'';
 value['answeredBy'+who]=previous?.['answeredBy'+who]||'';
 if(answer!==before||choice!==oldChoice){
 if(answer.trim()){value['answeredAt'+who]=now;value['answeredBy'+who]=actor.name;
 value['decided'+who]=value['decided'+who]||new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(now));
 if(value['decisionStatus'+who]!=='vertagt')value['decisionStatus'+who]='entschieden';
 }else{value['answeredAt'+who]='';value['answeredBy'+who]='';value['decided'+who]='';value['decisionStatus'+who]='offen';}
 }
 }
 return value;
}

function registerCamper(app,options={}){
 const express=require('express'),router=express.Router(),dir=options.dir||path.join(process.env.DATA_DIR||'/var/data','_kristine','camper'),store=createStore(dir),sessions=new Map(),attempts=new Map();
 let tokenProvider=options.accessToken;
 let mailbox=require('./camper-mailbox').createCamperMailbox(options.accessToken,{fetch:options.fetch});
 const usersFile=path.join(dir,'users.json');let usersQueue=Promise.resolve();
 async function users(){try{return JSON.parse(await fsp.readFile(usersFile,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 function localOrigin(req,res,next){if(['GET','HEAD'].includes(req.method))return next();try{if(new URL(req.get('origin')).host!==req.get('host'))throw Error();}catch{ return res.status(403).json({error:'Fremder Ursprung abgewiesen.'});}next();}
 async function identity(req){const value=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);const session=sessions.get(value);if(session&&session.expires>Date.now()){const user=(await users()).find(x=>x.id===session.userId&&!x.disabled);if(user)return {id:user.id,name:user.name,admin:false};}if(session)sessions.delete(value);return null;}
 function admin(req,res){const {requireAdmin}=require('./admin-auth');if(!requireAdmin(req,res))return false;if(req.kristineActor&&!req.kristineActor.isAlexander){res.status(403).json({error:'Nur Alexander kann Camper-Zugänge verwalten.'});return false;}return true;}
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');next();});
 router.use(localOrigin);
 router.get(['/enter'],(req,res)=>{res.set('Referrer-Policy','no-referrer');if(!admin(req,res))return;res.redirect(303,'/camper/');});
 router.use('/api/mailbox/send',express.json({limit:'4mb'}));
 router.use('/api',express.json({limit:'1mb'}));
 router.post('/api/login',wrap(async(req,res)=>{const key=req.ip,now=Date.now();let limit=attempts.get(key);if(!limit||limit.until<now){limit={count:0,until:now+900000};attempts.set(key,limit);}if(++limit.count>15)return res.status(429).json({error:'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.'});const user=(await users()).find(x=>x.login===String(req.body.login||'').toLowerCase().trim()&&!x.disabled);const salt=user?.salt||'00000000000000000000000000000000';const hash=await scrypt(String(req.body.password||'').slice(0,1024),salt,64);if(!user||!crypto.timingSafeEqual(hash,Buffer.from(user.hash,'hex')))return res.status(403).json({error:'Benutzer oder Passwort nicht korrekt.'});attempts.delete(key);const token=crypto.randomBytes(32).toString('base64url');sessions.set(token,{userId:user.id,expires:now+86400000*7});if(sessions.size>1000)for(const [k,v]of sessions)if(v.expires<now)sessions.delete(k);res.cookie(cookie,token,{httpOnly:true,secure:true,sameSite:'strict',path:'/camper',maxAge:86400000*7});res.json({ok:true});}));
 router.post('/api/logout',(req,res)=>{const value=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);sessions.delete(value);res.clearCookie(cookie,{path:'/camper',secure:true,httpOnly:true,sameSite:'strict'});res.json({ok:true});});
 router.use('/api',wrap(async(req,res,next)=>{const user=await identity(req);if(user){req.camperActor=user;return next();}if(!admin(req,res))return;req.camperActor={id:'alexander',name:req.kristineActor?.name||'Alexander',admin:true};next();}));
 router.get('/api/me',(req,res)=>res.json(req.camperActor));
 router.post('/api/mailbox/send',wrap(async(req,res)=>{const b=req.body;if(!/^[a-f0-9-]{36}$/i.test(b.requestId||''))throw Error('Versandkennung fehlt. Mail bitte neu öffnen.');if((b.projectFiles||[]).length>10||!Array.isArray(b.attachments||[]))throw Error('Höchstens 10 Anhänge auswählen.');const extras=[];let extraBytes=0;for(const id of (Array.isArray(b.projectFiles)?b.projectFiles:[])){const file=(await store.read()).files.find(f=>f.id===id);if(!file)throw Error('Projektdatei nicht gefunden.');if(file.storage==='onedrive')throw Error('Große OneDrive-Dateien bitte über den Projektlink teilen.');extraBytes+=file.size;if(extraBytes>2*1024*1024)throw Error('Anhänge zusammen maximal 2 MB.');extras.push({name:file.name,contentBytes:(await fsp.readFile(path.join(dir,'files',file.disk))).toString('base64')});}const input={...b,attachments:[...(b.attachments||[]),...extras]};mailbox.prepare(input);const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');const outdir=path.join(dir,'mail-outbox');await fsp.mkdir(outdir,{recursive:true});const file=path.join(outdir,b.requestId+'.json');let prior;try{prior=JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}if(prior){if(prior.digest!==digest)return res.status(409).json({error:'Mailinhalt geändert. Bitte eine neue Mail öffnen und vorher Gesendet prüfen.'});if(prior.status==='accepted')return res.json({accepted:true,mailbox:'man@krista.at',duplicate:true});return res.status(409).json({error:'Dieser Versandversuch wurde bereits gestartet. Bitte zuerst „Gesendet“ prüfen; bei unklarem Ausgang nicht nochmals senden.'});}const record={id:b.requestId,digest,by:req.camperActor.name,at:new Date().toISOString(),subject:String(b.subject||'').slice(0,300),status:'sending'};try{await fsp.writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')return res.status(409).json({error:'Versand läuft bereits.'});throw e;}try{const result=await mailbox.send(input);record.status='accepted';await fsp.writeFile(file,JSON.stringify(record),{mode:0o600});res.json(result);}catch(e){record.status='uncertain';await fsp.writeFile(file,JSON.stringify(record),{mode:0o600});throw e;}}));
 router.get('/api/mailbox/status',(req,res)=>res.json(mailbox.status()));
 router.get('/api/mailbox/messages',wrap(async(req,res)=>res.json(await mailbox.list(req.query.folder||'inbox'))));
 router.get('/api/mailbox/messages/:id',wrap(async(req,res)=>res.json(await mailbox.detail(req.params.id))));
 router.get('/api/mailbox/messages/:id/attachments/:aid',wrap(async(req,res)=>{const file=await mailbox.attachment(req.params.id,req.params.aid);res.type(file.type);res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.set('Content-Disposition',`${file.type==='application/octet-stream'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`);res.send(file.bytes);}));

 router.get('/api/users',wrap(async(req,res)=>{if(!req.camperActor.admin)return res.sendStatus(403);res.json((await users()).map(({id,name,login,disabled})=>({id,name,login,disabled})));}));
 router.post('/api/users',wrap(async(req,res)=>{if(!req.camperActor.admin)return res.sendStatus(403);const {name,login,password}=req.body;if(!name||name.length>80||!/^[a-z0-9_.@+-]{3,100}$/i.test(login||'')||typeof password!=='string'||password.length<12||password.length>200)throw Error('Name, Benutzername und Passwort mit mindestens 12 Zeichen erforderlich.');const salt=crypto.randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');const op=usersQueue.then(async()=>{const rows=await users();if(rows.some(x=>x.login===login.toLowerCase()))throw Error('Benutzername bereits vorhanden.');rows.push({id:crypto.randomUUID(),name,login:login.toLowerCase(),salt,hash});await fsp.mkdir(dir,{recursive:true});const tmp=usersFile+'.tmp';await fsp.writeFile(tmp,JSON.stringify(rows),{mode:0o600});await fsp.rename(tmp,usersFile);});usersQueue=op.catch(()=>{});await op;res.status(201).json({ok:true});}));
 router.patch('/api/users/:id',wrap(async(req,res)=>{if(!req.camperActor.admin)return res.sendStatus(403);const op=usersQueue.then(async()=>{const rows=await users();const row=rows.find(x=>x.id===req.params.id);if(!row)throw Error('Benutzer nicht gefunden.');row.disabled=!!req.body.disabled;const tmp=usersFile+'.tmp';await fsp.writeFile(tmp,JSON.stringify(rows),{mode:0o600});await fsp.rename(tmp,usersFile);});usersQueue=op.catch(()=>{});await op;res.json({ok:true});}));

 async function bankData(){
 const base=String(process.env.OUTGOING_CONNECTOR||process.env.ARCHIVE_CONNECTOR||'http://127.0.0.1:5051').replace(/\/+$/,'');
 const response=await (options.fetch||fetch)(base+'/revolut/balances',{headers:{Accept:'application/json',...(process.env.ADMIN_TOKEN?{'X-Krista-Token':process.env.ADMIN_TOKEN}:{})},signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok||!data.ok||!Array.isArray(data.accounts))throw Error('Revolut-Kontostand derzeit nicht erreichbar.');
 return data;
 }
 router.get('/api/bank-balance',wrap(async(req,res)=>{
 const data=await bankData();let selected=(await store.read()).tgeAccountId;
 if(!selected){const matches=data.accounts.filter(a=>/^(man[\s_-]*)?tge$/i.test(String(a.name||'').trim())&&a.state!=='closed');if(matches.length===1){selected=matches[0].id;await store.update(s=>{if(!s.tgeAccountId)s.tgeAccountId=selected;else selected=s.tgeAccountId;});}}
 const a=data.accounts.find(a=>a.id===selected);
 res.json({account:a?{id:a.id,name:a.name,balance:a.balance,currency:a.currency}:null,fetchedAt:data.fetchedAt,stale:!!data.stale,...(req.camperActor.admin?{accounts:data.accounts.map(a=>({id:a.id,name:a.name,currency:a.currency}))}:{})});
 }));
 router.put('/api/bank-account',wrap(async(req,res)=>{
 if(!req.camperActor.admin)return res.sendStatus(403);
 const data=await bankData();const a=data.accounts.find(a=>a.id===req.body.id);if(!a)throw Error('Konto nicht gefunden.');
 await store.update(s=>{s.tgeAccountId=a.id;});res.json({ok:true});
 }));

 const oneDrive=require('./camper-onedrive').registerOneDrive(router,{store,dir,accessToken:()=>tokenProvider,fetch:options.fetch,wrap,assignment:fileAssignment,modelUrl});
 router.post('/api/files/:id/preview',express.raw({type:'application/octet-stream',limit:'10mb'}),wrap(async(req,res)=>{
 const row=(await store.read()).files.find(f=>f.id===req.params.id);if(!row)return res.sendStatus(404);
 if(!Buffer.isBuffer(req.body)||!req.body.length)throw Error('Bitte ein Vorschaubild auswählen.');
 const img=req.body;if(!(img[0]===255&&img[1]===216)&&img.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'&&!(img.subarray(0,4).toString()==='RIFF'&&img.subarray(8,12).toString()==='WEBP'))throw Error('Bitte JPEG, PNG oder WebP für die Vorschau verwenden.');
 let bytes;try{bytes=await require('sharp')(req.body,{limitInputPixels:40000000}).rotate().resize(480,320,{fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();}catch{throw Error('Bitte ein gültiges JPEG-, PNG- oder WebP-Bild auswählen.');}
 const disk=crypto.randomUUID()+'.preview.jpg';await fsp.mkdir(path.join(dir,'files'),{recursive:true});await fsp.writeFile(path.join(dir,'files',disk),bytes,{flag:'wx',mode:0o600});
 try{res.json(await store.update(s=>{const f=s.files.find(f=>f.id===req.params.id);if(!f)throw Error('Datei fehlt.');f.previewDisk=disk;f.version=(f.version||1)+1;}));}catch(e){await fsp.unlink(path.join(dir,'files',disk));throw e;}
 }));
 router.get('/api/files/:id/preview',wrap(async(req,res)=>{const f=(await store.read()).files.find(f=>f.id===req.params.id);if(!f?.previewDisk)return res.sendStatus(404);res.type('image/jpeg');res.sendFile(path.join(dir,'files',f.previewDisk));}));
 router.get('/api/state',wrap(async(req,res)=>res.json(await store.read())));
 const kinds=['tasks','costs','hours','decisions','mails','ideas','purchases'];
 function validate(kind,b){const out={vehicle:['egon','elio','both'].includes(b.vehicle)?b.vehicle:'both',title:String(b.title||'').trim().slice(0,300),notes:String(b.notes||'').slice(0,10000),person:String(b.person||'').slice(0,80),date:String(b.date||'').slice(0,10)};if(!out.title)throw Error('Bitte eine Bezeichnung eingeben.');if(kind==='tasks'||kind==='decisions')out.status=['offen','in-arbeit','freigabe','erledigt'].includes(b.status)?b.status:'offen';if(kind==='costs'||kind==='hours'){const n=Number(b.amount);if(!Number.isFinite(n)||n<=0||n>10000000)throw Error('Bitte einen positiven Betrag bzw. Stundenwert eingeben.');out.amount=n;}if(kind==='costs')out.status=['einzahlung','geplant','bestellt','bezahlt'].includes(b.status)?b.status:'geplant';return details(kind,b,out);}
 router.put('/api/budget',wrap(async(req,res)=>{const b=req.body;if(!['egon','elio'].every(k=>Number.isFinite(b[k])&&b[k]>=0&&b[k]<100000000))throw Error('Budget ungültig.');res.json(await store.update(s=>{if(b.revision!==s.revision)throw Object.assign(Error('Projekt wurde inzwischen geändert. Bitte neu laden.'),{status:409});s.budget={egon:b.egon,elio:b.elio};}));}));
 router.post('/api/items/:kind',wrap(async(req,res)=>{const kind=req.params.kind;if(!kinds.includes(kind))return res.sendStatus(404);const value=validate(kind,req.body);res.status(201).json(await store.update(s=>{const now=new Date().toISOString();s[kind].push({...stampDecision(kind,value,null,req.camperActor,now),id:crypto.randomUUID(),version:1,by:req.camperActor.name,created:now});}));}));
 router.patch('/api/items/:kind/:id',wrap(async(req,res)=>{const kind=req.params.kind;if(!kinds.includes(kind))return res.sendStatus(404);const value=validate(kind,req.body);res.json(await store.update(s=>{const row=s[kind].find(x=>x.id===req.params.id);if(!row)throw Error('Eintrag fehlt.');if(row.version!==req.body.version)throw Object.assign(Error('Eintrag wurde inzwischen geändert. Bitte neu laden.'),{status:409});stampDecision(kind,value,row,req.camperActor);
 if(['tasks','decisions'].includes(kind)){const {history,...before}=row;row.history=[...(history||[]),{at:new Date().toISOString(),by:req.camperActor.name,before}];}
 Object.assign(row,value,{version:row.version+1,by:req.camperActor.name,updated:new Date().toISOString()});}));}));
 router.delete('/api/items/:kind/:id',wrap(async(req,res)=>{const kind=req.params.kind;if(!kinds.includes(kind))return res.sendStatus(404);res.json(await store.update(s=>{const i=s[kind].findIndex(x=>x.id===req.params.id);if(i<0||s[kind][i].version!==req.body.version)throw Object.assign(Error('Eintrag geändert oder bereits gelöscht. Bitte neu laden.'),{status:409});s[kind].splice(i,1);}));}));

 const types={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.pdf':'application/pdf','.skp':'application/octet-stream','.zip':'application/zip','.eml':'message/rfc822','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
 router.post('/api/files',wrap(async(req,res)=>{
 const name=path.basename(String(req.query.name||'')).slice(0,180),ext=path.extname(name).toLowerCase(),type=types[ext];
 if(!type||(!['idee'].includes(req.query.category)&&['.mp4','.mov','.webm'].includes(ext)))throw Error('Dateityp für diese Ablage nicht unterstützt.');
 const id=crypto.randomUUID(),disk=id+ext,folder=path.join(dir,'files'),target=path.join(folder,disk),temp=target+'.part';
 const url=modelUrl(req.query.modelUrl);await fsp.mkdir(folder,{recursive:true});
 let size=0;const signature=[];let signatureSize=0;
 const limit=new Transform({transform(chunk,enc,done){size+=chunk.length;if(size>MAX_FILE)return done();if(signatureSize<16){const part=chunk.subarray(0,16-signatureSize);signature.push(part);signatureSize+=part.length;}done(null,chunk);}});
 try{
 await pipeline(req,limit,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
 const b=Buffer.concat(signature);
 if(size>MAX_FILE)throw Object.assign(Error('Dateien über 10 MB werden automatisch in OneDrive gespeichert. Bitte OneDrive verbinden.'),{status:413});
 if(!size)throw Error('Datei ist leer.');
 if(type==='application/zip'&&b.subarray(0,2).toString()!=='PK'||type==='application/pdf'&&!b.subarray(0,5).equals(Buffer.from('%PDF-'))||type==='image/jpeg'&&!(b[0]===255&&b[1]===216)||type==='image/png'&&b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||type==='image/webp'&&b.subarray(8,12).toString()!=='WEBP'||['.mp4','.mov'].includes(ext)&&b.subarray(4,8).toString()!=='ftyp'||ext==='.webm'&&b.subarray(0,4).toString('hex')!=='1a45dfa3')throw Error('Dateiinhalt passt nicht zum Dateityp.');
 await fsp.rename(temp,target);
 const result=await store.update(s=>{
 const assignment=fileAssignment({...req.query,category:ext==='.eml'?'mail':req.query.category},s),now=new Date().toISOString();
 s.files.push({id,name,disk,type,size,...assignment,modelUrl:url,version:1,versionLabel:String(req.query.version||'').slice(0,80),created:now,by:req.camperActor.name});
 if(assignment.category==='idee')s.ideas.push({id:crypto.randomUUID(),version:1,title:name,vehicle:assignment.vehicle,fileId:id,url:'',imageUrl:'',topic:'',notes:'',created:now,by:req.camperActor.name});
 });res.status(201).json(result);
 }catch(e){await fsp.unlink(temp).catch(()=>{});await fsp.unlink(target).catch(()=>{});throw e;}
 }));

 const fileCategories=['plan','angebot','rechnung','sonstiges','idee','mail'];
 function fileAssignment(b,s){const category=fileCategories.includes(b.category)?b.category:'plan';const purchaseId=String(b.purchaseId||'');if(purchaseId&&!s.purchases.some(p=>p.id===purchaseId))throw Error('Einkaufsvorgang fehlt.');return {category,purchaseId,vehicle:['egon','elio','both'].includes(b.vehicle)?b.vehicle:'both'};}
 router.post('/api/mailbox/messages/:id/attachments/:aid/import',wrap(async(req,res)=>{
 const bytesFile=await mailbox.attachment(req.params.id,req.params.aid);
 const snap=await store.read();fileAssignment(req.body,snap);
 const id=crypto.randomUUID(),ext={ 'application/pdf':'.pdf','image/jpeg':'.jpg','image/png':'.png'}[bytesFile.type]||'.bin',disk=id+ext;
 await fsp.mkdir(path.join(dir,'files'),{recursive:true});await fsp.writeFile(path.join(dir,'files',disk),bytesFile.bytes,{flag:'wx',mode:0o600});
 try{res.status(201).json(await store.update(s=>{
 const duplicate=s.files.find(f=>f.sourceMessage===req.params.id&&f.sourceAttachment===req.params.aid);
 if(duplicate)throw Object.assign(Error('Dieser Anhang wurde bereits abgelegt. Du findest ihn unter Pläne & Dateien.'),{status:409});
 s.files.push({id,disk,name:bytesFile.name,type:bytesFile.type,size:bytesFile.bytes.length,...fileAssignment(req.body,s),version:1,sourceMessage:req.params.id,sourceAttachment:req.params.aid,created:new Date().toISOString(),by:req.camperActor.name,versionLabel:''});
 }));}catch(e){await fsp.unlink(path.join(dir,'files',disk));throw e;}
 }));
 router.patch('/api/files/:id',wrap(async(req,res)=>res.json(await store.update(s=>{
 const f=s.files.find(f=>f.id===req.params.id);if(!f)throw Error('Datei fehlt.');
 if((f.version||1)!==req.body.version)throw Object.assign(Error('Datei wurde inzwischen geändert. Bitte neu laden.'),{status:409});
 Object.assign(f,fileAssignment(req.body,s),{version:(f.version||1)+1,updated:new Date().toISOString()});
 }))));

 router.get('/api/files/:id',wrap(async(req,res)=>{const row=(await store.read()).files.find(x=>x.id===req.params.id);if(!row)return res.sendStatus(404);if(row.storage==='onedrive')return oneDrive.download(row,res);res.type(row.type);res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.set('Content-Disposition',`${req.query.download||!['image/jpeg','image/png','image/webp','application/pdf','video/mp4','video/webm','video/quicktime'].includes(row.type)?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g,'%27')}`);res.sendFile(path.join(dir,'files',row.disk));}));
 router.get(['','/','/app.js','/style.css'],(req,res)=>{if(req.query.token&&['/',''].includes(req.path)){res.set('Referrer-Policy','no-referrer');if(!admin(req,res))return;return res.redirect(303,'/camper/');}const name=req.path==='/app.js'?'app.js':req.path==='/style.css'?'style.css':'index.html';res.sendFile(path.join(__dirname,'camper-public',name));});
 router.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status||400).json({error:err.status===413?'Dateien über 10 MB werden automatisch in OneDrive gespeichert. Bitte OneDrive verbinden.':err.message});});app.use('/camper',router);return {store,connectMailbox(accessToken){tokenProvider=accessToken;mailbox=require('./camper-mailbox').createCamperMailbox(accessToken);}};
}
module.exports={registerCamper,createStore,modelUrl,stampDecision};

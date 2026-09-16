'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const engine=require('./public/bauprojekt/engine');
const root=path.join(__dirname,'public','bauprojekt');
function createStore(dataDir){
  const dir=path.join(dataDir,'_bauprojekt');let pending=Promise.resolve();
  const valid=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Object.assign(Error('Ungültige Projekt-ID'),{status:400});return path.join(dir,id+'.json');};
  async function read(id){try{return JSON.parse(await fs.readFile(valid(id),'utf8'));}catch(e){if(e.code==='ENOENT')throw Object.assign(Error('Projekt nicht gefunden'),{status:404});throw e;}}
  function write(p,create=false){const action=pending.then(async()=>{engine.validate(p);await fs.mkdir(dir,{recursive:true});const file=valid(p.id);if(!create){const old=await read(p.id);if(old.revision!==p.revision)throw Object.assign(Error('Projekt wurde inzwischen geändert. Bitte neu laden.'),{status:409});}
    const value={...p,revision:create?1:p.revision+1,updatedAt:new Date().toISOString()},tmp=file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),'utf8');await fs.rename(tmp,file);return value;});pending=action.catch(()=>{});return action;}
  return {read,write,async list(){await fs.mkdir(dir,{recursive:true});const files=(await fs.readdir(dir)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));return Promise.all(files.map(async f=>{const p=await read(f.slice(0,-5));return {id:p.id,name:p.name,jobId:p.jobId||'',revision:p.revision,updatedAt:p.updatedAt};}));}};
}
function registerBauprojekt(app,{dataDir,requireAdmin,adminToken=''}){
  const store=createStore(dataDir);
  const shareToken=adminToken?crypto.createHmac('sha256',adminToken).update('bauprojekt-only-v1').digest('base64url'):'';
  const guard=(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(shareToken&&req.headers['x-admin-token']===shareToken)return next();if(requireAdmin(req,res))next();};
  const action=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||400).json({error:e.message});}};
  app.get('/bauprojekt',(_req,res)=>{res.setHeader('Referrer-Policy','no-referrer');res.sendFile(path.join(root,'index.html'));});
  app.get('/bauprojekt/freigabe',(req,res)=>{if(!requireAdmin(req,res))return;res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.type('html').send('<!doctype html><meta charset="utf-8"><title>Bauprojekt-Zugang</title><h1>Bauprojekt-Zugang</h1><p>Dieser Schlüssel gilt ausschließlich für das Bauprojektmodul und alle darin gespeicherten Projekte. Er erlaubt Ansehen und Bearbeiten.</p><p>Zugriffsschlüssel: <code>'+shareToken+'</code></p><p><a href="/bauprojekt">Bauprojekt öffnen</a></p><p>Den Schlüssel im Anmeldefeld eingeben. Zum Weitergeben nur diesen Schlüssel verwenden.</p>');});
  app.get('/bauprojekt/api/catalog',guard,action(async(_req,res)=>res.json(JSON.parse(await fs.readFile(path.join(__dirname,'bauprojekt-catalog.json'),'utf8')))));
  app.get('/bauprojekt/api/sample',guard,action(async(_req,res)=>res.json(JSON.parse(await fs.readFile(path.join(__dirname,'bauprojekt-sample.json'),'utf8')))));
  app.get('/bauprojekt/api/projects',guard,action(async(_req,res)=>res.json(await store.list())));
  app.post('/bauprojekt/api/projects',guard,action(async(req,res)=>{const p={...req.body,id:crypto.randomUUID()};res.status(201).json(await store.write(p,true));}));
  app.get('/bauprojekt/api/projects/:id',guard,action(async(req,res)=>res.json(await store.read(req.params.id))));
  app.put('/bauprojekt/api/projects/:id',guard,action(async(req,res)=>{if(req.body.id!==req.params.id)throw Error('Projekt-ID stimmt nicht überein.');res.json(await store.write(req.body));}));
}
module.exports={registerBauprojekt,createStore};

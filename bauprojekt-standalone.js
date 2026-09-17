'use strict';
// Same application and storage as the Kristine integration, without other Kristine services.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createStore}=require('./bauprojekt');
const dataDir=process.env.BAUPROJEKT_DATA_DIR||path.join(__dirname,'.bauprojekt-data'),store=createStore(dataDir),root=path.join(__dirname,'public','bauprojekt');
const token=process.env.BAUPROJEKT_TOKEN||'',host=process.env.BAUPROJEKT_HOST||'127.0.0.1';
const publicOrigin=process.env.BAUPROJEKT_PUBLIC_URL?new URL(process.env.BAUPROJEKT_PUBLIC_URL).origin:null;
if(!token&&!['127.0.0.1','localhost','::1'].includes(host))throw Error('Für Netzwerkbetrieb BAUPROJEKT_TOKEN setzen.');
async function body(req){let text='';for await(const c of req){text+=c;if(Buffer.byteLength(text)>4*1024*1024)throw Error('Projektdatei zu groß');}return JSON.parse(text);}
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
 try{if(u.pathname==='/healthz'&&req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end('{"ok":true}');}
 if(u.pathname.startsWith('/bauprojekt/api/')){
   if(token&&req.headers['x-admin-token']!==token){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Zugriffsschlüssel erforderlich.'}));}
   if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==(publicOrigin||`http://${req.headers.host}`))throw Object.assign(Error('Fremder Ursprung abgewiesen.'),{status:403});
   if(req.method==='GET'&&['/bauprojekt/api/catalog','/bauprojekt/api/sample'].includes(u.pathname)){res.setHeader('Content-Type','application/json; charset=utf-8');return res.end(await fs.readFile(path.join(__dirname,'bauprojekt-'+u.pathname.split('/').pop()+'.json'),'utf8'));}
   if(!/^\/bauprojekt\/api\/projects(?:\/[a-f0-9-]{36})?$/.test(u.pathname))throw Object.assign(Error('Nicht gefunden'),{status:404});
   const id=u.pathname.split('/')[4];let value,status=200;
   if(req.method==='GET')value=id?await store.read(id):await store.list();
   else if(req.method==='POST'&&!id){value=await store.write({...await body(req),id:crypto.randomUUID()},true);status=201;}
   else if(req.method==='PUT'&&id){const p=await body(req);if(p.id!==id)throw Error('Projekt-ID stimmt nicht überein.');value=await store.write(p);}
   else throw Object.assign(Error('Nicht gefunden'),{status:404});
   res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(value));
 }
 const file=u.pathname==='/'||u.pathname==='/bauprojekt'?'index.html':u.pathname.replace(/^\/public\/bauprojekt\//,'');
 if(!['index.html','engine.js','app.js','style.css','catalog.json','sample.json','pdf-lib.min.js','pdf.js','print-preview.js','pdf-view.mjs','pdf-worker.mjs'].includes(file))throw Object.assign(Error('Nicht gefunden'),{status:404});
 const types={html:'text/html',js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json'};res.setHeader('Content-Type',(types[file.split('.').pop()]||'text/plain')+'; charset=utf-8');res.end(await fs.readFile(path.join(root,file)));
 }catch(e){res.writeHead(e.status||400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:e.message}));}});
if(require.main===module)server.listen(Number(process.env.PORT||process.env.BAUPROJEKT_PORT||4317),host,()=>console.log('Bauprojekt gestartet auf Port '+server.address().port));
module.exports=server;

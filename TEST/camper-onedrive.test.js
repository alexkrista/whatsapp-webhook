'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {registerOneDrive,createOneDrive,LOCAL_LIMIT}=require('../camper-onedrive'),{createStore}=require('../camper-project');
test('large OneDrive upload verifies Graph before creating an idempotent tile and limits access',async(t)=>{
 const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'drive-test-'));t.after(async()=>{assert.equal(path.dirname(dir),root);await fs.rm(dir,{recursive:true,force:true});});
 const routes=[],router={get(p,h){routes.push({p,m:'GET',h});},post(p,h){routes.push({p,m:'POST',h});}},store=createStore(dir);let storedName='',complete=false,deny=false;
 const folders=new Map([['root',[]]]);let targetParent='',folderNo=0;const calls=[];
 const request=async(url,options)=>{assert.match(options.headers.Authorization,/Bearer fake-token/);const suffix=url.replace('https://graph.microsoft.com/v1.0','');calls.push({suffix,method:options.method});
  if(deny)return {ok:false,status:403};
  if(options.method==='GET'&&suffix.includes(':/'))return {ok:false,status:400,json:async()=>({error:{code:'invalidRequest',message:'Relative path rejected'}})};
  let data;
  if(suffix==='/me/drive')data={id:'drive'};
  else if(suffix==='/drives/drive/root')data={id:'root',folder:{}};
  else if(suffix.endsWith('createUploadSession')){assert.deepEqual(JSON.parse(options.body),{});const match=suffix.match(/^\/drives\/drive\/items\/([^/]+):\/(.+):\/createUploadSession$/);assert.ok(match,'explicit drive and parent required');targetParent=decodeURIComponent(match[1]);storedName=decodeURIComponent(match[2]);data={uploadUrl:'https://example.invalid/upload-secret',expirationDateTime:'2026-10-29T00:00:00Z'};}
  else if(suffix.endsWith('/children')){const parent=decodeURIComponent(suffix.split('/')[4]);if(options.method==='POST'){const body=JSON.parse(options.body),id='folder'+(++folderNo);data={id,name:body.name,folder:{}};folders.get(parent).push(data);folders.set(id,[]);}else data={value:[...(folders.get(parent)||[]),...(parent===targetParent?[{id:'item',name:storedName,size:complete?850*1024*1024:1,file:{mimeType:'application/octet-stream'},parentReference:{id:targetParent,driveId:'drive'}}]:[])]};}
  else if(suffix.endsWith('/thumbnails'))data={value:[{medium:{url:'https://example.invalid/thumb'}}]};
  else if(suffix==='/drives/drive/items/item')data={id:'item',name:storedName,size:complete?850*1024*1024:1,file:{mimeType:'application/octet-stream'},parentReference:{id:targetParent,driveId:'drive'},'@microsoft.graph.downloadUrl':'https://example.invalid/download'};
  else if(/^\/drives\/drive\/items\/folder[0-9]+$/.test(suffix))data=Array.from(folders.values()).flat().find(f=>f.id===suffix.split('/').pop());
  else throw Error('Unexpected Graph request: '+suffix);
  return {ok:true,status:200,json:async()=>data};
 };
 const assignment=b=>({vehicle:b.vehicle||'both',category:b.category||'plan',purchaseId:''});const wrap=fn=>fn;
 const drive=registerOneDrive(router,{store,dir,accessToken:()=>async()=>'fake-token',fetch:request,wrap,assignment});
 async function call(p,m='GET',body={},params={},actor={id:'alex',name:'Alexander',admin:true}){const route=routes.find(r=>r.p===p&&r.m===m);let data,status=200,redirect;const res={status(n){status=n;return this;},json(d){data=d;return this;},sendStatus(n){status=n;},set(){},redirect(n,url){redirect=url;status=n;}};await route.h({body,params,camperActor:actor},res);return {data,status,redirect};}
 assert.equal((await call('/api/onedrive/status')).data.connected,true);
 assert.equal((await call('/api/onedrive/prepare','POST')).data.ready,true);const preparedCount=folderNo;await call('/api/onedrive/prepare','POST');assert.equal(folderNo,preparedCount);assert.equal((await call('/api/onedrive/prepare','POST',{}, {},{id:'other',admin:false})).status,403);const fixedRoot=JSON.parse(await fs.readFile(path.join(dir,'onedrive-project-root.json'),'utf8'));assert.equal(fixedRoot.driveId,'drive');assert.equal(fixedRoot.id,'folder1');
 await assert.rejects(call('/api/onedrive/uploads','POST',{name:'x.pdf',size:LOCAL_LIMIT}),/ungültig/);
 const upload=(await call('/api/onedrive/uploads','POST',{name:'Camper.skp',size:850*1024*1024,vehicle:'elio',category:'plan'})).data;
 assert.ok(upload.uploadUrl);assert.equal((await store.read()).files.length,0);assert.equal((await store.read()).uploadUrl,undefined);
 await assert.rejects(call('/api/onedrive/uploads/:id/complete','POST',{}, {id:upload.id}),/nicht vollständig/);
 await assert.rejects(call('/api/onedrive/uploads/:id/complete','POST',{}, {id:upload.id},{id:'other',admin:false}),/Kein Zugriff/);
 complete=true;let s=(await call('/api/onedrive/uploads/:id/complete','POST',{itemId:'item'}, {id:upload.id})).data;assert.equal(s.files.length,1);assert.equal(s.files[0].storage,'onedrive');assert.equal(s.files[0].name,'Camper.skp');assert.equal(s.files[0].disk,undefined);assert.equal(s.files[0].size,850*1024*1024);
 s=(await call('/api/onedrive/uploads/:id/complete','POST',{}, {id:upload.id})).data;assert.equal(s.files.length,1);
 assert.equal((await call('/api/files/:id/cloud-thumbnail','GET',{}, {id:upload.id})).redirect,'https://example.invalid/thumb');
 let url;await drive.download(s.files[0],{set(){},redirect(n,u){url=u;}});assert.equal(url,'https://example.invalid/download');
 deny=true;assert.equal((await call('/api/onedrive/status')).data.connected,false);await assert.rejects(createOneDrive(async()=>'fake-token',request).graph('/me/drive'),/Freigabe/);
});
test('browser extracts an embedded SketchUp PNG across a read boundary',async()=>{
 const {JSDOM}=require('jsdom'),root=path.resolve(__dirname,'..'),html=await fs.readFile(path.join(root,'camper-public/index.html'),'utf8');let script=await fs.readFile(path.join(root,'camper-public/app.js'),'utf8');script=script.replace(/\r\n/g,'\n').replace('boot();\n})();','window.testPng=embeddedPng;\n})();');
 const dom=new JSDOM(html,{url:'https://example.test/camper/',runScripts:'outside-only'}),w=dom.window;w.Blob=Blob;w.fetch=async()=>({ok:false,json:async()=>({})});w.eval(script);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');const data=Buffer.concat([Buffer.alloc(4*1024*1024-3),png,Buffer.alloc(20)]),blob=new Blob([data]);
 try{const result=await w.testPng(blob);assert.ok(result);assert.deepEqual(Buffer.from(await result.arrayBuffer()),png);assert.equal(await w.testPng(new Blob(['not a sketchup preview'])),null);}finally{w.close();}
});
test('browser uploads >10 MB directly in aligned chunks and resumes a failed chunk',async()=>{
 const {JSDOM}=require('jsdom'),root=path.resolve(__dirname,'..'),html=await fs.readFile(path.join(root,'camper-public/index.html'),'utf8'),script=await fs.readFile(path.join(root,'camper-public/app.js'),'utf8');
 const s={revision:0,budget:{egon:0,elio:0},tasks:[],decisions:[],files:[],ideas:[],purchases:[],costs:[],hours:[],mails:[]},size=25*1024*1024,ranges=[];let complete=false,failed=false,sessions=0;
 const dom=new JSDOM(html,{url:'https://example.test/camper/',runScripts:'outside-only'}),w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(url,opts={})=>{let data={},ok=true,status=200;const p=String(url).replace('/camper/api/','');if(url==='https://upload.example/chunks'){if(opts.method==='PUT'){const range=opts.headers['Content-Range'];ranges.push(range);assert.equal(opts.headers.Authorization,undefined);assert.ok(opts.body.size<=10*1024*1024);if(range.startsWith('bytes 10485760-')&&!failed){failed=true;return {ok:false,status:503,json:async()=>({})};}complete=range.endsWith('26214399/26214400');status=complete?201:202;data=complete?{id:'item'}:{nextExpectedRanges:[String(Number(range.split('-')[1].split('/')[0])+1)+'-']};}else data={nextExpectedRanges:['10485760-']};}
 else if(p==='me')data={name:'Alexander',admin:true};else if(p==='users')data=[];else if(p==='state')data=s;else if(p==='onedrive/status')data={connected:true};else if(p==='bank-balance')data={account:null,accounts:[]};else if(p==='onedrive/uploads'){sessions++;data={id:'cloud',uploadUrl:'https://upload.example/chunks'};}else if(p==='onedrive/uploads/cloud/complete'){if(!complete){ok=false;status=400;data={error:'Noch nicht vollständig'};}else{s.files=[{id:'cloud',storage:'onedrive',name:'Large.pdf',size,type:'application/pdf',vehicle:'both',category:'plan',created:new Date().toISOString()}];data=s;}}else throw Error('Unexpected '+p);return {ok,status,json:async()=>JSON.parse(JSON.stringify(data))};};
 const wait=async fn=>{for(let n=0;n<100;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout: '+w.document.querySelector('#message').textContent+' ranges='+JSON.stringify(ranges));};
 try{w.eval(script);await wait(()=>w.document.querySelector('[data-page="Pläne & Dateien"]'));await new Promise(r=>setTimeout(r,30));w.document.querySelector('[data-page="Pläne & Dateien"]').click();const event=new w.Event('drop',{bubbles:true,cancelable:true});event.dataTransfer={files:[{name:'Large.pdf',size,slice:(start,end)=>new Blob([new Uint8Array(end-start)])}]};w.document.querySelector('#plan-drop').dispatchEvent(event);const form=w.document.querySelector('#edit-form');form.dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(()=>w.document.querySelector('#message').textContent.includes('unterbrochen'));await wait(()=>!form.querySelector('[type=submit]').disabled);assert.equal(w.document.querySelector('#editor').open,true);form.dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(()=>!w.document.querySelector('#editor').open);assert.equal(sessions,1);assert.deepEqual(ranges,['bytes 0-10485759/26214400','bytes 10485760-20971519/26214400','bytes 10485760-20971519/26214400','bytes 20971520-26214399/26214400']);assert.equal(s.files.length,1);}finally{w.close();}
});

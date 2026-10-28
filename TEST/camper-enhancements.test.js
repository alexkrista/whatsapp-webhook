'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{Readable}=require('node:stream');
const root=path.resolve(__dirname,'..');
const auth=require.resolve('../admin-auth');require.cache[auth]={id:auth,filename:auth,loaded:true,exports:{requireAdmin(req,res){if(req.headers.admin)return true;res.status(403).json({error:'Forbidden'});return false;}}};
const {registerCamper}=require('../camper-project');
test('decision history, conflict protection, streamed ideas, bank isolation and mapping',async(t)=>{
 const express=require('express'),app=express(),dir=await fs.mkdtemp(path.join(root,'test-data-'));
 t.after(async()=>{assert.equal(path.dirname(dir),root);await fs.rm(dir,{recursive:true,force:true});});
 const bank={ok:true,accounts:[{id:'tge',name:'MAN TGE',currency:'EUR',balance:'1234.56'},{id:'company',name:'Firma',currency:'EUR',balance:'9876.54'}],totals:{EUR:'11111.10'},fetchedAt:'2026-10-28T08:00:00Z'};
 const project=registerCamper(app,{dir,fetch:async()=>({ok:true,json:async()=>bank})});
 const router=app._router.stack.find(l=>l.regexp.toString().includes('camper')).handle;
 async function call(route,method='GET',body={},params={},query={},admin=true){
  const layer=router.stack.find(l=>l.route&&l.route.path===route&&l.route.methods[method.toLowerCase()]);assert.ok(layer,route);
  const req=Readable.from(Buffer.isBuffer(body)?[body]:[]);Object.assign(req,{body:Buffer.isBuffer(body)?undefined:body,params,query,method,headers:{admin},camperActor:{id:'alexander',name:'Alexander',admin}});
  let result,status=200;const res={headersSent:false,status(n){status=n;return this;},json(v){result=v;return this;},sendStatus(n){status=n;return this;}};
  let error;for(const h of layer.route.stack){await h.handle(req,res,e=>{error=e;});if(error)break;}if(error)throw error;return {status,data:result};
 }
 let s=(await call('/api/items/:kind','POST',{title:'Fensterfarbe',vehicle:'both',types:['decision']},{kind:'tasks'})).data;
 let r=s.tasks[0];s=(await call('/api/items/:kind/:id','PATCH',{...r,answerElio:'Schwarz',decisionStatusElio:'entschieden',decidedElio:'2026-10-28'},{kind:'tasks',id:r.id})).data;
 assert.equal(s.tasks[0].answerEgon,'');assert.equal(s.tasks[0].answerElio,'Schwarz');assert.equal(s.tasks[0].history[0].before.answerElio,'');assert.equal(s.tasks[0].history[0].by,'Alexander');
 await assert.rejects(call('/api/items/:kind/:id','PATCH',{...r,answerEgon:'Weiss'},{kind:'tasks',id:r.id}),/inzwischen/);
 await assert.rejects(call('/api/items/:kind','POST',{title:'x',askedDate:'broken',types:['decision']},{kind:'tasks'}),/Datum/);
 const pdf=Buffer.from('%PDF-1.4\ntest');s=(await call('/api/files','POST',pdf,{}, {name:'Inspiration.pdf',vehicle:'elio',category:'idee'})).data;
 assert.equal(s.ideas.length,1);assert.equal(s.ideas[0].fileId,s.files[0].id);assert.deepEqual(await fs.readFile(path.join(dir,'files',s.files[0].disk)),pdf);
 const big=Buffer.alloc(51*1024*1024);big.write('%PDF-1.4');s=(await call('/api/files','POST',big,{}, {name:'large-plan.pdf',category:'plan'})).data;assert.equal(s.files.at(-1).size,big.length);
 await assert.rejects(call('/api/files','POST',Buffer.from('bad'),{},{name:'wrong.pdf',category:'plan'}),/Dateiinhalt/);
 const before=(await fs.readdir(path.join(dir,'files'))).length;await assert.rejects(call('/api/files','POST',pdf,{}, {name:'missing.pdf',purchaseId:'missing'}),/Einkaufsvorgang/);assert.equal((await fs.readdir(path.join(dir,'files'))).length,before);
 let b=(await call('/api/bank-balance','GET',{}, {},{},false)).data;assert.equal(b.account.id,'tge');assert.equal(b.account.balance,'1234.56');assert.equal(b.accounts,undefined);assert.equal(b.totals,undefined);assert.equal((await project.store.read()).tgeAccountId,'tge');
 assert.equal((await call('/api/bank-account','PUT',{id:'company'},{},{},false)).status,403);
 await call('/api/bank-account','PUT',{id:'company'});assert.equal((await call('/api/bank-balance')).data.account.id,'company');assert.equal(bank.totals.EUR,'11111.10');
 assert.equal((await project.store.read()).budget.egon,0);
});
test('UI: editable decisions, separate answers, history and ideas drop',async()=>{
 const {JSDOM}=require('jsdom');const html=await fs.readFile(path.join(root,'camper-public/index.html'),'utf8'),script=await fs.readFile(path.join(root,'camper-public/app.js'),'utf8');
 const state={revision:0,budget:{egon:0,elio:0},tasks:[{id:'q',version:1,title:'Farbe',vehicle:'both',types:['decision'],status:'offen',answerEgon:'',answerElio:'',created:'2026-10-28T08:00:00Z'}],decisions:[],ideas:[],files:[],costs:[],hours:[],purchases:[],mails:[]};
 const dom=new JSDOM(html,{url:'https://example.test/camper/',runScripts:'outside-only'}),w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const patches=[];w.fetch=async(url,opts={})=>{const p=String(url).replace('/camper/api/','');let data;if(p==='me')data={name:'Alexander',admin:true};else if(p==='users')data=[];else if(p==='state')data=state;else if(p==='bank-balance')data={account:null,accounts:[]};else if(p==='items/tasks/q'){const b=JSON.parse(opts.body);patches.push(b);Object.assign(state.tasks[0],b,{version:b.version+1});data=state;}else throw Error(p);return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))};};
 const tick=()=>new Promise(r=>setTimeout(r,20));w.eval(script);await tick();await tick();
 w.document.querySelector('[data-page="Entscheidungen"]').click();assert.equal(w.document.querySelectorAll('tbody tr').length,2);
 const el=w.document.querySelector('[data-field="answerElio"]');el.value='Schwarz';el.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();assert.equal(patches[0].answerElio,'Schwarz');assert.equal(patches[0].answerEgon,'');assert.equal(w.document.querySelector('[data-field="decisionStatusElio"]').value,'entschieden');
 w.document.querySelector('[data-page="Ideen & Inspiration"]').click();assert.ok(w.document.querySelector('#idea-drop'));w.document.querySelector('[data-action="upload-idea"]').click();assert.equal(w.document.querySelector('[name=category]').value,'idee');assert.match(w.document.querySelector('[name=file]').accept,/mp4/);dom.window.close();
});

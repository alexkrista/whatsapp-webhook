"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require.resolve('../public/regie-assistant.html'),'utf8'),script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const all=[{type:'work',jobId:'A',jobName:'Baustelle A',from:'07:00',to:'09:00'},{type:'lunch',from:'09:00',to:'09:30'},{type:'work',jobId:'B',jobName:'Baustelle B',from:'09:30',to:'11:00'},{type:'work',jobId:'A',jobName:'Baustelle A',from:'11:00',to:'12:00'},{type:'work',jobId:'C',jobName:'Baustelle C',from:'13:00',to:''}];
async function harness(t,rows=all,date='2026-10-15'){
 const dom=new JSDOM(html,{url:`https://regie.test/public/regie-assistant.html?employeeId=E&jobId=C&date=${date}`,runScripts:'outside-only'}),w=dom.window,posts=[];
 t.after(()=>w.close());w.scrollTo=()=>{};const NativeDate=w.Date;w.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-15T15:00:00Z']))}static now(){return new NativeDate('2026-10-15T15:00:00Z').valueOf()}};
 w.fetch=async(raw,options={})=>{const url=new URL(raw,w.location.href);let result={};
 if(options.method==='POST'){const body=JSON.parse(options.body);posts.push({path:url.pathname,body});result={report:{id:'saved-'+body.segment?.jobId,photos:[],materials:[],status:body.draft?'draft':'prepared'}}}
 else if(url.pathname.includes('/segments/'))result={segments:rows};
 else if(url.pathname.endsWith('/bootstrap'))result={states:{E:{mode:'working',activeJobOverride:{jobId:'C',jobName:'Baustelle C'}}},employees:[{id:'E',name:'Clemens'}]};
 else if(url.pathname.includes('/team-candidates/'))result={candidates:[]};
 else if(url.pathname.endsWith('/drafts'))result={drafts:[]};
 else if(url.pathname.endsWith('/materials'))result={materials:[]};
 else result={items:[]};return {ok:true,status:200,text:async()=>JSON.stringify(result)};
 };
 const context=dom.getInternalVMContext();new vm.Script(script).runInContext(context);
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))};await settle();
 return {w,context,posts,settle,read:code=>vm.runInContext(code,context),choose:async id=>{w.document.querySelector(`[data-regie-job="${id}"]`).click();await settle()}};
}
test('all daily sites are offered despite current-site URL; repeated blocks form one choice',async t=>{
 const h=await harness(t);assert.equal(h.w.document.querySelectorAll('[data-regie-job]').length,3);assert.ok(h.w.document.getElementById('sJob').classList.contains('on'));assert.equal(h.read('segment'),null);
 await h.choose('A');assert.equal(h.read('segment.jobId'),'A');assert.equal(h.read('peopleData[0].blocks.length'),2);assert.match(h.w.document.getElementById('context').textContent,/Baustelle A/);assert.equal(h.posts.length,0);
 h.read("hoursMode='day';teamMode='self';peopleData[0].selected=true;calculateTimes();$('description').value='Arbeiten A'");await h.read('completeReport(false)');
 assert.equal(h.posts.filter(post=>post.path.endsWith('/manual-action')).length,0);assert.ok(h.posts.every(post=>post.body.segment.jobId==='A'));assert.equal(h.posts.at(-1).body.employees[0].netMinutes,180);
 assert.equal(h.w.document.getElementById('doneAnother').classList.contains('hidden'),false);assert.ok(!new URL(h.w.document.getElementById('doneAnother').href).searchParams.has('jobId'));
});
test('each completed site and the currently running site can be selected independently',async t=>{
 for(const id of ['A','B','C']){const h=await harness(t);await h.choose(id);assert.equal(h.read('segment.jobId'),id);assert.ok(h.read('peopleData[0].blocks.every(block=>block.jobId===segment.jobId)'));}
});
test('day closing from an earlier report ends the actual current job, not the report job',async t=>{
 const h=await harness(t);await h.choose('A');await h.read('finishCurrentWork()');const end=h.posts.find(post=>post.path.endsWith('/manual-action'));assert.equal(end.body.jobId,'C');assert.equal(h.read('segment.jobId'),'A');
});
test('one site skips selection; yesterday does not acquire invented running hours',async t=>{
 const one=await harness(t,[all[0]]);assert.equal(one.w.document.querySelectorAll('[data-regie-job]').length,0);assert.equal(one.read('segment.jobId'),'A');
 const yesterday=await harness(t,all,'2026-10-14');assert.equal(yesterday.w.document.querySelectorAll('[data-regie-job]').length,2);assert.equal(yesterday.w.document.querySelector('[data-regie-job="C"]'),null);
});

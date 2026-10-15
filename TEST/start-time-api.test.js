"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {registerKristine}=require('../kristine');
async function harness(t,events=[]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'start-rule-')),root=path.join(dir,'_kristine');await fs.mkdir(root);await fs.writeFile(path.join(root,'time-events.json'),JSON.stringify(events));
 const routes=new Map(),app={};for(const method of ['get','post','put','delete','patch'])app[method]=(route,fn)=>routes.set(`${method} ${route}`,fn);
 const service=registerKristine(app,{dataDir:dir,publicDir:dir,requireAdmin:()=>true,readEmployees:async()=>[{id:'P',name:'Production'}]});await service.startupReady;t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const call=async(method,route,args={})=>{const res={statusCode:200,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};await routes.get(method+' '+route)({body:{},params:{},query:{},headers:{},...args},res);return res};return{root,call};
}
test('manual 06:45 start is stored and returned as 07:00, retaining actualAt for audit',async t=>{
 const h=await harness(t),r=await h.call('post','/kristine/api/manual-action',{body:{employeeId:'P',employeeName:'Production',date:'2026-10-13',action:'start',at:'06:45',jobId:'26101'}});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(r.body.at,'07:00');
 const events=JSON.parse(await fs.readFile(path.join(h.root,'time-events.json'),'utf8'));assert.equal(events[0].at,'07:00');assert.equal(events[0].actualAt,'06:45');
});
test('existing open-month early bookings display at 07:00 and keep project assignment',async t=>{
 const base={employeeId:'P',employeeName:'Production',date:'2026-10-13',jobId:'26101',jobName:'Jansen'},h=await harness(t,[{...base,type:'start',at:'06:45',source:'office'},{...base,type:'ende',at:'12:00'}]);
 const r=await h.call('get','/kristine/api/segments/:employeeId/:date',{params:{employeeId:'P',date:base.date}});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(r.body.segments[0].from,'07:00');assert.equal(r.body.segments[0].jobId,'26101');
});
test('day-close editing cannot reintroduce a 06:45 start',async t=>{
 const h=await harness(t),r=await h.call('put','/kristine/api/segments/:employeeId/:date',{params:{employeeId:'P',date:'2026-10-13'},body:{employeeName:'Production',segments:[{type:'work',from:'06:45',to:'12:00',jobId:'26101',jobName:'Jansen'}]}});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(r.body.segments[0].from,'07:00');
 const events=JSON.parse(await fs.readFile(path.join(h.root,'time-events.json'),'utf8'));assert.ok(events.every(event=>event.at>='07:00'));const corrections=JSON.parse(await fs.readFile(path.join(h.root,'day-corrections.json'),'utf8'));assert.equal(corrections[0].history.at(-1).after[0].actualFrom,'06:45');
});

test('07:15 rounds to 07:00 and 07:16 remains actual on the manual start path',async t=>{
 for(const [at,wanted] of [['07:15','07:00'],['07:16','07:16']]){const h=await harness(t),r=await h.call('post','/kristine/api/manual-action',{body:{employeeId:'P',date:'2026-10-13',action:'start',at,jobId:'26101'}});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(r.body.at,wanted)}
});
test('reading and editing a closed month cannot rewrite its frozen early start',async t=>{
 const h=await harness(t),segments=[{type:'work',from:'06:45',to:'12:00',jobId:''}];await fs.writeFile(path.join(h.root,'month-closures.json'),JSON.stringify([{employeeId:'P',month:'2026-09',closedAt:'2026-10-01T10:00:00Z',days:[{date:'2026-09-13',employeeId:'P',segments,events:[]}]}]));
 const params={employeeId:'P',date:'2026-09-13'},r=await h.call('get','/kristine/api/segments/:employeeId/:date',{params});assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(r.body.segments[0].from,'06:45');assert.equal(r.body.monthClosed,true);
 const edit=await h.call('put','/kristine/api/segments/:employeeId/:date',{params,body:{segments}});assert.equal(edit.statusCode,409);
});

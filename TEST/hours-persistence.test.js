"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),vm=require("node:vm");
const D=require("../public/ui/baustellen-data"),{collectionCatalog}=require("../sammelmappen"),{registerJobSourceCache}=require("../job-source-cache");
const root=path.resolve(__dirname,"..");
const job=(jobId,actual=0,target=0)=>({jobId,status:"Auftrag",calculation:{actualHours:actual,orderHours:actual,calculatedHours:target,fixedCalculatedHours:target}});
async function server(t){
  const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),"hours-reopen-"));t.after(()=>fsp.rm(dataDir,{recursive:true,force:true}));
  const ids=["24177","26018","25047",...Array.from({length:36},(_,i)=>String(27000+i))];
  const jobs=[...ids.map(id=>job(id)),job("25018",0,510),job("keckeis_gabi_harry",26)];jobs[0]=job("24177",27.75,1323.53);
  const collections=collectionCatalog(jobs,[{id:"S24177",mainJobId:"24177",memberJobIds:ids},{id:"S25018",mainJobId:"25018",memberJobIds:["25018","keckeis_gabi_harry"]}]);
  await Promise.all(jobs.map(j=>fsp.mkdir(path.join(dataDir,j.jobId))));
  const routes=new Map();registerJobSourceCache({get:(url,fn)=>routes.set("GET "+url,fn),put:(url,fn)=>routes.set("PUT "+url,fn)},{dataDir,requireAdmin:(req,res)=>{if(req.allowed)return true;res.status(403).json({ok:false});return false},readJobMeta:async id=>({wwProjectNumber:id})});
  async function call(raw,init={},allowed=true){
    const url=new URL(raw,"https://protokoll.krista.at"),own=url.pathname.match(/^\/admin\/api\/job\/([^/]+)\/ww-cache\/(hours|billing)$/),res={code:200,status(code){this.code=code;return this},json(data){this.body=data},setHeader(){}};
    const route=own?`/admin/api/job/:jobId/ww-cache/:kind`:url.pathname,fn=routes.get((init.method||"GET")+" "+route);assert(fn,"Unknown route "+route);
    await fn({allowed,params:own?{jobId:own[1],kind:own[2]}:{},query:Object.fromEntries(url.searchParams),body:init.body?JSON.parse(init.body):{}},res);return res;
  }
  return {dataDir,jobs,collections,call};
}
function browser(db,hash,remote={}){
  const calls=[],events=[],nodes=new Map(),listeners=new Map();
  const rows=[...db.jobs,...db.collections].map(j=>{const cell={innerHTML:"",classList:{toggle(){}}};nodes.set(j.jobId,cell);return {dataset:{job:j.jobId},querySelector:s=>s===".hours"?cell:null}});
  const document={readyState:"loading",addEventListener(){},getElementById:()=>null,querySelectorAll:s=>s===".job-row[data-job]"?rows:[]};
  const window={BaustellenData:D,addEventListener(type,fn){listeners.set(type,fn)},dispatchEvent(event){events.push(event);listeners.get(event.type)?.(event)}};
  const response=(data,code=200)=>({ok:code<400,status:code,json:async()=>data,text:async()=>JSON.stringify(data)});
  const fetch=async(raw,init={})=>{
    const url=new URL(raw,"https://protokoll.krista.at");calls.push({path:url.pathname,method:init.method||"GET",host:url.hostname});
    if(url.hostname!=="protokoll.krista.at"){
      if(remote.wait)await remote.wait;
      if(remote.fail)throw new TypeError("Office offline");
      const id=JSON.parse(init.body).projectNumber,n=({24177:300.71,26018:348.62,25047:616.14,25018:468}[id]||0)+(id==="24177"?(remote.extra||0):0);
      return response({ok:true,hours:{projectNumber:id,found:true,totalHours:n,rows:n?[{date:"2026-09-01",employeeName:"Max",hours:n}]:[],days:n?[{date:"2026-09-01",hours:n}]:[]}});
    }
    if(url.pathname==="/admin/api/jobs")return response({jobs:db.jobs,collections:db.collections});
    if(url.pathname==="/kristine/api/bootstrap")return response({employees:[],timeEvents:[],states:{}});
    if(url.pathname==="/admin/api/employees")return response({employees:[]});
    if(url.pathname==="/admin/api/brain-permit")return response({permit:"test"});
    const res=await db.call(raw,init);return response(res.body,res.code);
  };
  const context={window,document,fetch,location:{hash,search:"",pathname:hash?"/kristine/sammelmappe":"/kristine/baustellen",origin:"https://protokoll.krista.at"},URL,URLSearchParams,Intl,Date,Map,Set,AbortSignal,CustomEvent:class{constructor(type){this.type=type}},console,setTimeout,clearTimeout,queueMicrotask};
  for(const file of ["baustellen-sources.js","baustellen-live-hours.js"])vm.runInNewContext(fs.readFileSync(path.join(root,"public/ui",file),"utf8"),context);
  return {api:window.BaustellenLiveHours,window,calls,events,nodes};
}
test("open, close and reopen: both collections reuse server hours in the list before any office request",async t=>{
  const db=await server(t);
  await browser(db,"#S24177").api.refresh();await browser(db,"#S25018").api.refresh();
  const files=await fsp.readdir(path.join(db.dataDir,"_system/ww-cache/hours"));assert.equal(files.length,40);
  const list=browser(db,"",{fail:true});await list.api.refresh();
  assert.equal(list.api.summary("S24177").total.toFixed(2),"1293.22");assert.equal(list.api.summary("S24177").remaining.toFixed(2),"30.31");
  assert.equal(list.api.summary("S25018").total,494);assert.equal(list.api.summary("S25018").remaining,16);
  assert.equal(list.api.summary("24177").total.toFixed(2),"328.46","head retains only its own hours");
  assert.equal(list.calls.filter(row=>row.host!=="protokoll.krista.at").length,0,"a list refresh never requests WW");
  assert.equal(list.calls.filter(row=>row.path==="/admin/api/ww-cache/hours").length,1);
  assert.match(list.nodes.get("S24177").innerHTML,/1 293,2 h/);assert.match(list.nodes.get("S25018").innerHTML,/494 h/);
  assert.match(list.nodes.get("S24177").innerHTML,/Gespeicherter Stand:/);
  assert.equal(list.api.summary("S24177").available,true);assert.equal(list.api.summary("S24177").complete,false,"saved is not reported as freshly synced");
  let release,seenCached;const wait=new Promise(resolve=>{release=resolve}),cached=new Promise(resolve=>{seenCached=resolve});
  const reopen=browser(db,"#S24177",{wait,extra:1});reopen.window.addEventListener("krista:live-hours-updated",()=>seenCached());
  const refreshing=reopen.api.refresh();await cached;
  assert.equal(reopen.api.summary("S24177").total.toFixed(2),"1293.22","saved hours visible while office is still pending");
  release();await refreshing;assert.equal(reopen.api.summary("S24177").total.toFixed(2),"1294.22");assert.equal(reopen.api.summary("S24177").complete,true);
  const offline=browser(db,"#S24177",{fail:true});await offline.api.refresh();
  assert.equal(offline.api.summary("S24177").total.toFixed(2),"1294.22","office failure must keep the new durable sum");
  assert.equal(offline.api.summary("S24177").available,true);assert.equal(offline.api.summary("S24177").complete,false);
  assert.equal(offline.api.personDayHours("S24177").reduce((sum,row)=>sum+row.hours,0).toFixed(2),"1266.47","WW productive rows are restored without a second pause deduction");
});
test("batch cache is authenticated and bounded; absent or broken sources are not zero-hour snapshots",async t=>{
  const db=await server(t);
  assert.equal((await db.call("/admin/api/ww-cache/hours?projectNumbers=24177",{},false)).code,403);
  for(const value of ["../24177","S24177","",Array.from({length:101},(_,i)=>String(30000+i)).join(",")])assert.equal((await db.call("/admin/api/ww-cache/hours?projectNumbers="+encodeURIComponent(value))).code,400);
  const result=await db.call("/admin/api/ww-cache/hours?projectNumbers=24177,26018,24177");assert.deepEqual(result.body.snapshots,[]);assert.deepEqual(result.body.missing,["24177","26018"]);
  await browser(db,"#S24177").api.refresh();await fsp.writeFile(path.join(db.dataDir,"_system/ww-cache/hours/26018.json"),"broken");
  const partial=await db.call("/admin/api/ww-cache/hours?projectNumbers=24177,26018");assert.equal(partial.body.snapshots.length,1);assert.deepEqual(partial.body.missing,["26018"]);
  const list=browser(db,"");await list.api.refresh();assert.equal(list.api.summary("S24177").available,false);
});

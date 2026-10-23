"use strict";
const H=require("./public/ui/baustellen-hours-core"),D=require("./public/ui/baustellen-data");
const fs=require("node:fs/promises"),path=require("node:path");
const B=require("./public/ui/regie-billing-state");
const n=x=>Number.isFinite(Number(x))?Number(x):0,round=x=>Math.round((x+Number.EPSILON)*100)/100;
const key=x=>String(x||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const canonical=x=>({"edimock":"Edmund Mock","mandi":"Manuel Faes","mandifaes":"Manuel Faes","maxkrista":"Maximilian Krista","cathringrabherr":"Cathrin Anna Grabherr","annacathringrabherr":"Cathrin Anna Grabherr"})[key(x)]||x;
function missingHoursPlan({jobId,rows=[],reports=[],documents=[],employees=[],throughDate=""}){
 const master=employees.map(e=>({...e,name:canonical(e.name||e.employeeName)}));
 const person=p=>{const name=canonical(p.name||p.employeeName||""),id=String(p.employeeId||p.id||"");const found=master.find(e=>id&&String(e.id)===id)||master.find(e=>key(e.name)===key(name));return {id:String(found?.id||id),name:found?.name||name}};
 const stamped=new Map(),covered=new Map(),reserved=new Map(),pendingByDay=new Map(),issues=[];
 for(const raw of rows){
  const p=person(raw),date=String(raw.date||"").slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||throughDate&&date>throughDate||n(raw.hours)<=0)continue;
  if(!p.name||key(p.name)==="winworkergesamt"){issues.push(date+": Mitarbeiterzuordnung fehlt");continue}
  const k=date+"|"+key(p.name),old=stamped.get(k)||{...p,date,hours:0};old.hours+=n(raw.hours);stamped.set(k,old);
 }
 const local=reports.filter(r=>String(r.jobId)===String(jobId)&&r.status!=="deleted"&&r.documentType!=="delivery_note");
 const docIds=new Set(local.map(r=>"regie-office-"+r.id));
 const all=[...B.dedupeReports(documents.filter(d=>d.type==="regie_report"&&d.documentType!=="delivery_note"&&!docIds.has(d.id))).map(d=>({date:d.reportDate,employees:d.employeeDetails||[],totalHours:d.totalHours,draft:d.processingStatus==="draft",id:d.id})),...local.map(r=>({...r,draft:r.status==="draft"||r.processingStatus==="draft"||!String(r.description||"").trim()}))];
 for(const r of all){
  const date=String(r.date||"").slice(0,10);
  if(r.draft){if(!pendingByDay.has(date))pendingByDay.set(date,[]);pendingByDay.get(date).push(r.id)}
  if(!(r.employees||[]).length){if(n(r.totalHours)>0&&stamped.size&&[...stamped.values()].some(x=>x.date===date)){issues.push(date+": Bericht ohne Mitarbeiterdetails");for(const x of stamped.values())if(x.date===date)reserved.set(date+"|"+key(x.name),Infinity)}continue}
  for(const raw of r.employees||[]){
   const p=person(raw),exact=date+"|"+key(p.name);
   // Only an unambiguous first-name match can bridge legacy WW names.
   const first=key(String(p.name).split(/\s+/)[0]),matches=[...stamped.keys()].filter(k=>k.startsWith(date+"|")&&key(stamped.get(k).name.split(/\s+/)[0])===first);
   const k=stamped.has(exact)?exact:matches.length===1?matches[0]:exact;
   const target=r.draft?reserved:covered;target.set(k,(target.get(k)||0)+Math.max(0,n(raw.hours)));
  }
 }
 const days=new Map();
 for(const [k,p] of stamped){
  const reported=n(covered.get(k)),draft=reserved.get(k)||0,missing=Math.max(0,p.hours-reported),create=Number.isFinite(draft)?Math.max(0,missing-draft):0;
  const row={...p,booked:round(p.hours),reported:round(reported),draft:Number.isFinite(draft)?round(draft):0,missing:round(missing),create:round(create)};
  if(!days.has(p.date))days.set(p.date,{date:p.date,employees:[],draftIds:pendingByDay.get(p.date)||[]});
  days.get(p.date).employees.push(row);
 }
 const list=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,booked:round(d.employees.reduce((s,e)=>s+e.booked,0)),reported:round(d.employees.reduce((s,e)=>s+e.reported,0)),missing:round(d.employees.reduce((s,e)=>s+e.missing,0)),create:round(d.employees.reduce((s,e)=>s+e.create,0))}));
 return {days:list,booked:round(list.reduce((s,d)=>s+d.booked,0)),reported:round(list.reduce((s,d)=>s+d.reported,0)),missing:round(list.reduce((s,d)=>s+d.missing,0)),draftHours:round(list.flatMap(d=>d.employees).reduce((s,e)=>s+e.draft,0)),issues:[...new Set(issues)]};
}
async function recordedRows({dataDir,job,bootstrap,now=new Date()}){
 const wwByMember=new Map(),found=[],missingProjects=[];
 for(const ref of D.projects(job,[job])){
  try{const s=JSON.parse(await fs.readFile(path.join(dataDir,"_system","ww-cache","hours",ref.projectNumber+".json"),"utf8"));found.push({number:ref.projectNumber,data:H.parseWwHours({hours:s.data,syncedAt:s.syncedAt,cached:true},ref.projectNumber)})}
  catch(e){if(e.code!=="ENOENT")throw e;missingProjects.push(ref.projectNumber)}
 }
 const ww=H.combineWw(found);wwByMember.set(String(job.jobId),ww);
 const engine=H.createEngine({jobs:[job],bootstrap,wwByMember,now}),fused=engine.singleFusion(job),kr=engine.kristineFor(job),rows=[];
 for(const [date,people] of kr.dayPeople||[])if(!fused.legacyCutover||date>=fused.legacyCutover)for(const p of people.values())rows.push({date,name:p.name,hours:p.hours});
 for(const r of ww.rows)if(fused.legacyCutover?r.date<fused.legacyCutover:!fused.excluded.has(r.key))rows.push({date:r.date,name:r.employeeName,hours:r.hours});
 return {rows,missingProjects};
}
module.exports={missingHoursPlan,recordedRows};

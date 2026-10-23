"use strict";
const fs=require("node:fs/promises"),path=require("node:path");
const {missingHoursPlan,recordedRows}=require("./regie-missing-hours");
const safe=value=>/^[A-Za-z0-9_-]+$/.test(String(value||""));
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch(error){if(error.code==="ENOENT")return fallback;throw error}}
async function employeeRegieRequirements({dataDir,employeeId,date,jobId="",readJobMeta,readDocumentation,employeeMaster=[],now=new Date()}){
 if(!safe(employeeId)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||jobId&&!safe(jobId))throw Error("Mitarbeiter, Baustelle oder Datum ungültig.");
 const root=path.join(dataDir,"_kristine");
 const [events,archive,legacy,system,assignments,reports,states]=await Promise.all([json(path.join(root,"time-events.json"),[]),json(path.join(root,"project-time-archive.json"),[]),json(path.join(root,"employees.json"),[]),json(path.join(dataDir,"_system","employees.json"),[]),json(path.join(root,"assignments.json"),[]),json(path.join(root,"regie-reports.json"),[]),json(path.join(root,"states.json"),{})]);
 const employees=[...system,...legacy,...employeeMaster],employee=employees.find(e=>String(e.id||e.employeeId)===employeeId);
 if(!employee)throw Error("Mitarbeiter nicht gefunden.");
 const jobIds=new Set([jobId,...events.filter(e=>String(e.employeeId)===employeeId&&e.date===date).map(e=>e.jobId),...archive.filter(e=>String(e.employeeId)===employeeId&&e.date===date).flatMap(e=>(e.segments||[]).filter(s=>s.type==="work").map(s=>s.jobId)),...assignments.filter(a=>String(a.employeeId)===employeeId&&a.date===date).map(a=>a.jobId)].filter(safe));
 const result=[];
 const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna"}).format(now);
 for(const id of jobIds){
  const meta=await readJobMeta(id);if(meta?.regieOnly!==true)continue;
  const docs=readDocumentation?await readDocumentation(id):await json(path.join(dataDir,id,"_documentation","index.json"),[]);
  const recorded=await recordedRows({dataDir,job:{...meta,jobId:id},bootstrap:{timeEvents:events,projectTimeArchive:archive,employees,states,today},now});
  const p=missingHoursPlan({jobId:id,rows:recorded.rows.filter(r=>r.date===date),reports,documents:docs,employees,throughDate:date});
  const persons=p.days.find(d=>d.date===date)?.employees||[];
  const person=persons.find(p=>p.id===employeeId);
  const pending=p.days.find(d=>d.date===date)?.draftIds||[];
  const ownDraft=reports.some(r=>pending.includes(r.id)&&(r.employees||[]).some(e=>String(e.id||e.employeeId)===employeeId));
  const booked=person?.booked||0,reported=person?.reported||0,missing=person?.missing||0;
  result.push({jobId:id,jobName:meta.name||id,regieOnly:true,booked,reported,missing,draft:ownDraft,required:booked>.01,complete:booked>.01&&missing<=.01&&!ownDraft,unresolved:p.issues.length>0&&booked>.01});
 }
 return {ok:true,employeeId,date,jobs:result,missing:result.filter(j=>j.required&&(!j.complete||j.unresolved))};
}
module.exports={employeeRegieRequirements};

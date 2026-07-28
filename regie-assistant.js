"use strict";
const fs=require("fs");
const fsp=require("fs/promises");
const path=require("path");

function registerRegieAssistant(app,{dataDir,requireAdmin,publicDir}){
  const ROOT=path.join(dataDir,"_kristine");
  const REPORTS=path.join(ROOT,"regie-reports.json");
  const CONFIRMATIONS=path.join(ROOT,"regie-confirmations.json");
  const TIME_EVENTS=path.join(ROOT,"time-events.json");
  const ASSIGNMENTS=path.join(ROOT,"assignments.json");
  const EMPLOYEES=path.join(ROOT,"employees.json");
  async function readJson(file,fallback){try{return JSON.parse(await fsp.readFile(file,"utf8"));}catch{return fallback}}
  async function writeJson(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});const tmp=file+".tmp";await fsp.writeFile(tmp,JSON.stringify(value,null,2));await fsp.rename(tmp,file)}
  const clean=(v,n=1000)=>String(v??"").trim().slice(0,n);
  const num=v=>{const n=Number(String(v??"").replace(",","."));return Number.isFinite(n)?n:0};
  function minutes(hm){const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/);return m?+m[1]*60 + +m[2]:null}
  function validRange(from,to,min,max){const a=minutes(from),b=minutes(to),lo=minutes(min),hi=minutes(max);return a!==null&&b!==null&&lo!==null&&hi!==null&&a>=lo&&b<=hi&&b>a}
  function buildSegments(events,employeeId,date){
    const rows=(events||[]).filter(e=>String(e.employeeId)===String(employeeId)&&String(e.date)===String(date)).sort((a,b)=>String(a.at||"").localeCompare(String(b.at||"")));
    const result=[];
    for(let i=0;i<rows.length-1;i++){
      const a=rows[i],b=rows[i+1];
      if(!["start","weiter","resume"].includes(String(a.type||a.command||"").toLowerCase()))continue;
      result.push({id:`seg_${i}`,from:a.at,to:b.at,jobId:clean(a.jobId),jobName:clean(a.jobName||a.jobId),employeeId:clean(a.employeeId),employeeName:clean(a.employeeName)});
    }
    return result;
  }
  app.get("/kristine/regie",(req,res)=>{const file=path.join(publicDir||path.join(process.cwd(),"public"),"regie-assistant.html");if(!fs.existsSync(file))return res.status(404).send("regie-assistant.html fehlt");res.sendFile(file)});
  app.get("/kristine/api/regie/context",async(req,res)=>{
    try{
      const date=clean(req.query.date,10)||new Date().toISOString().slice(0,10),employeeId=clean(req.query.employeeId,100);
      const [events,assignments,employees]=await Promise.all([readJson(TIME_EVENTS,[]),readJson(ASSIGNMENTS,[]),readJson(EMPLOYEES,[])]);
      let segments=buildSegments(events,employeeId,date);
      if(!segments.length){
        segments=(assignments||[]).filter(a=>String(a.employeeId)===employeeId&&String(a.date)===date).map((a,i)=>({id:`assignment_${i}`,from:a.from||"07:00",to:a.to||"17:00",jobId:clean(a.jobId),jobName:clean(a.jobName||a.jobId),employeeId,employeeName:clean(a.employeeName)}));
      }
      const dayJobIds=new Set(segments.map(s=>s.jobId).filter(Boolean));
      const team=(assignments||[]).filter(a=>String(a.date)===date&&dayJobIds.has(String(a.jobId))).map(a=>({id:clean(a.employeeId),name:clean(a.employeeName||employees.find(e=>String(e.id)===String(a.employeeId))?.name||a.employeeId)}));
      const unique=[...new Map(team.map(x=>[x.id,x])).values()];
      res.json({ok:true,date,segments,team:unique});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}
  });
  app.post("/kristine/api/regie",async(req,res)=>{
    try{
      const b=req.body||{},segment=b.segment||{};
      if(!validRange(b.from,b.to,segment.from,segment.to))return res.status(400).json({ok:false,error:`Regiezeit muss innerhalb ${segment.from}-${segment.to} liegen`});
      if(!Array.isArray(b.people)||!b.people.length)return res.status(400).json({ok:false,error:"Mindestens eine Person auswählen"});
      if(!clean(b.description))return res.status(400).json({ok:false,error:"Beschreibung fehlt"});
      const reports=await readJson(REPORTS,[]),confirmations=await readJson(CONFIRMATIONS,[]),now=new Date().toISOString();
      const report={id:`regie_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,status:"prepared",date:clean(b.date,10),jobId:clean(segment.jobId),jobName:clean(segment.jobName),segment:{from:segment.from,to:segment.to},from:clean(b.from,5),to:clean(b.to,5),createdBy:b.createdBy||b.people[0],people:b.people.map(p=>({id:clean(p.id),name:clean(p.name)})),description:clean(b.description,4000),materials:(b.materials||[]).map(m=>({materialId:clean(m.materialId),product:clean(m.product),quantity:num(m.quantity),unit:clean(m.unit),color:clean(m.color),room:clean(m.room),component:clean(m.component),area:clean(m.area),extraAnswer:clean(m.extraAnswer),labelPhotoName:clean(m.labelPhotoName)})),photos:(b.photos||[]).map(p=>({name:clean(p.name),type:clean(p.type)})),createdAt:now,updatedAt:now};
      reports.push(report);
      for(const person of report.people){if(String(person.id)===String(report.createdBy.id))continue;confirmations.push({id:`confirm_${report.id}_${person.id}`,reportId:report.id,employeeId:person.id,employeeName:person.name,status:"open",createdAt:now})}
      await Promise.all([writeJson(REPORTS,reports.slice(-10000)),writeJson(CONFIRMATIONS,confirmations.slice(-20000))]);
      res.json({ok:true,report,message:"Regiebericht vorbereitet. Das Team erhält die Bestätigung."});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}
  });
  app.get("/kristine/api/regie/confirmations",async(req,res)=>{const employeeId=clean(req.query.employeeId,100);const rows=await readJson(CONFIRMATIONS,[]);res.json({ok:true,items:rows.filter(x=>x.employeeId===employeeId&&x.status==="open")})});
  app.post("/kristine/api/regie/confirmations/:id",async(req,res)=>{try{const rows=await readJson(CONFIRMATIONS,[]),item=rows.find(x=>x.id===req.params.id);if(!item)return res.status(404).json({ok:false,error:"Bestätigung nicht gefunden"});item.status=req.body?.accept===false?"rejected":"confirmed";item.updatedAt=new Date().toISOString();await writeJson(CONFIRMATIONS,rows);res.json({ok:true,item})}catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}});
  app.get("/admin/api/regie-reports",async(req,res)=>{if(!requireAdmin(req,res))return;res.json({ok:true,reports:await readJson(REPORTS,[])})});
}
module.exports={registerRegieAssistant};

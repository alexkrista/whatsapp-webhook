"use strict";

// Zentrale Arbeitszeitmodelle.
// Eine Datei ist die Wahrheit: /_system/worktime-models.json.
// Die Mitarbeiterkarte ordnet nur worktimeModelId zu, KRISTINE bearbeitet hier
// Planung, Fink-Soll und optionale fixe Fink-Ausgabe im selben Modell.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const MODEL_FILE = path.join(DATA_DIR, "_system", "worktime-models.json");
const DAYS = [1,2,3,4,5,6,7]; // Mo..So

const hhmm = (value) => /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : "";
function mins(value){ const m=String(value||"").match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1])*60+Number(m[2]) : null; }
function hm(total){ total=Math.max(0,Math.round(Number(total)||0)); return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`; }
function overlap(a1,a2,b1,b2){ const s=Math.max(mins(a1)??0,mins(b1)??0),e=Math.min(mins(a2)??0,mins(b2)??0); return Math.max(0,e-s); }
function netHours(row){
  const a=mins(row.from),b=mins(row.to); if(a===null||b===null||b<=a)return 0;
  const breaks=overlap(row.from,row.to,row.pauseFrom,row.pauseTo)+overlap(row.from,row.to,row.lunchFrom,row.lunchTo);
  return Math.max(0,(b-a-breaks)/60);
}
function row(id,days=[],from="",to="",lunchFrom="",lunchTo="",pauseFrom="",pauseTo="",activityCode="",activityLabel=""){
  return { id, days, from, to, lunchFrom, lunchTo, pauseFrom, pauseTo, activityCode, activityLabel };
}
function alexFixedRow(){ return row("alex-fink-mo-fr",[1,2,3,4,5],"07:00","13:48","","","","","022","Baustelle < 120 km"); }
function emptyBlocks({fixed=false,alex=false}={}){
  return {
    planning:{label:"Planungsstunden",rows:[]},
    finkTarget:{label:"Sollstunden Finkzeit",rows:alex?[row("alex-soll-mo-fr",[1,2,3,4,5],"07:00","13:48")]:[]},
    finkFixed:{label:"Finkzeit-Ausgabe fix",enabled:fixed,rows:alex?[alexFixedRow()]:[]}
  };
}

const OFFICE_MODELS = [
  {id:"office-bettina",name:"Bettina",officeModel:true,configured:false,automaticTime:false,blocks:emptyBlocks()},
  {id:"office-dunja",name:"Dunja",officeModel:true,configured:false,automaticTime:false,blocks:emptyBlocks()},
  {id:"office-geri",name:"Geri",officeModel:true,configured:false,automaticTime:false,blocks:emptyBlocks({fixed:true})},
  {id:"office-judith",name:"Judith",officeModel:true,configured:false,automaticTime:false,blocks:emptyBlocks({fixed:true})},
  {id:"office-alex",name:"Alex",officeModel:true,configured:true,automaticTime:true,automaticPayrollHours:6.8,payrollReason:"Baustelle < 120 km",projectTimeSource:"actual_stamps",blocks:emptyBlocks({fixed:true,alex:true})}
].map(x=>({active:true,systemProtected:false,timeModelVersion:2,...x}));

function currentSeason(model){
  const month=new Date().getMonth()+1;
  return (model?.seasons||[]).find(s=>(s.months||[]).map(Number).includes(month)) || (model?.seasons||[])[0] || null;
}
function groupLegacyRows(model,kind){
  const season=currentSeason(model); if(!season)return [];
  const groups=new Map();
  for(const day of DAYS){
    const r=season.weekdays?.[String(day===7?0:day)] || {};
    let from="",to="",pauseFrom="",pauseTo="",lunchFrom="",lunchTo="";
    if(kind==="planning"){
      if(r.free || !r.from || !r.to)continue;
      from=r.from;to=r.to;
      if(Number(r.otherBreakMinutes||0)>0){pauseFrom="09:00";pauseTo=hm(9*60+Number(r.otherBreakMinutes||0));}
      if(Number(r.lunchBreakMinutes||0)>0){lunchFrom="12:00";lunchTo=hm(12*60+Number(r.lunchBreakMinutes||0));}
    }else{
      const hours=Number(r.payrollTargetHours ?? model?.payrollTargetHoursWeekday ?? 0);
      if(hours<=0)continue;
      from="07:00";to=hm(7*60+hours*60);
    }
    const sig=[from,to,lunchFrom,lunchTo,pauseFrom,pauseTo].join("|");
    if(!groups.has(sig))groups.set(sig,row(`${kind}-${groups.size+1}`,[],from,to,lunchFrom,lunchTo,pauseFrom,pauseTo));
    groups.get(sig).days.push(day);
  }
  return [...groups.values()];
}
function ensureBlocks(model){
  const copy={...model};
  if(copy.timeModelVersion===2 && copy.blocks)return copy;
  const planning=groupLegacyRows(copy,"planning");
  const finkTarget=groupLegacyRows(copy,"finkTarget");
  copy.timeModelVersion=2;
  copy.blocks={
    planning:{label:"Planungsstunden",rows:planning},
    finkTarget:{label:"Sollstunden Finkzeit",rows:finkTarget},
    finkFixed:{label:"Finkzeit-Ausgabe fix",enabled:Boolean(copy.automaticTime),rows:[]}
  };
  return copy;
}
function cleanRow(raw,index){
  const days=[...new Set((Array.isArray(raw?.days)?raw.days:[]).map(Number).filter(d=>DAYS.includes(d)))].sort((a,b)=>a-b);
  return {
    id:String(raw?.id||`r${Date.now()}_${index}`).replace(/[^A-Za-z0-9_-]/g,"_").slice(0,80),
    days,
    from:hhmm(raw?.from),to:hhmm(raw?.to),lunchFrom:hhmm(raw?.lunchFrom),lunchTo:hhmm(raw?.lunchTo),pauseFrom:hhmm(raw?.pauseFrom),pauseTo:hhmm(raw?.pauseTo),
    activityCode:String(raw?.activityCode||"").trim().slice(0,30),activityLabel:String(raw?.activityLabel||"").trim().slice(0,100)
  };
}
function cleanBlock(raw,label,fixed=false){
  return {label, ...(fixed?{enabled:raw?.enabled===true}:{}), rows:(Array.isArray(raw?.rows)?raw.rows:[]).slice(0,30).map(cleanRow).filter(r=>r.days.length)};
}
function legacyFromBlocks(blocks){
  const weekdays={};
  for(const day of DAYS){
    const p=(blocks.planning.rows||[]).find(r=>r.days.includes(day));
    const t=(blocks.finkTarget.rows||[]).find(r=>r.days.includes(day));
    const key=String(day===7?0:day);
    if(!p){weekdays[key]={free:true,from:"",to:"",lunchBreakMinutes:0,otherBreakMinutes:0,targetHours:0,payrollTargetHours:t?Number(netHours(t).toFixed(2)):0};continue;}
    weekdays[key]={
      free:false,from:p.from,to:p.to,
      lunchBreakMinutes:overlap(p.from,p.to,p.lunchFrom,p.lunchTo),
      otherBreakMinutes:overlap(p.from,p.to,p.pauseFrom,p.pauseTo),
      targetHours:Number(netHours(p).toFixed(2)),
      payrollTargetHours:t?Number(netHours(t).toFixed(2)):0
    };
  }
  const targetVals=Object.values(weekdays).map(r=>Number(r.payrollTargetHours||0)).filter(v=>v>0);
  return {
    seasons:[{id:"active",name:"Aktuelles Modell",months:[1,2,3,4,5,6,7,8,9,10,11,12],weekdays}],
    payrollTargetHoursWeekday:targetVals.length?Number((targetVals.reduce((a,b)=>a+b,0)/targetVals.length).toFixed(2)):0
  };
}
function cleanModel(raw,existing={}){
  const id=String(raw?.id||existing?.id||"").replace(/[^A-Za-z0-9_-]/g,"-").slice(0,80);
  const blocks={
    planning:cleanBlock(raw?.blocks?.planning,"Planungsstunden"),
    finkTarget:cleanBlock(raw?.blocks?.finkTarget,"Sollstunden Finkzeit"),
    finkFixed:cleanBlock(raw?.blocks?.finkFixed,"Finkzeit-Ausgabe fix",true)
  };
  const legacy=legacyFromBlocks(blocks);
  const fixedRows=blocks.finkFixed.enabled?blocks.finkFixed.rows:[];
  const fixedHours=fixedRows.map(netHours).filter(v=>v>0);
  return {
    ...existing,
    id,
    name:String(raw?.name||existing?.name||id||"Arbeitsmodell").trim().slice(0,120),
    active:raw?.active!==false,
    systemProtected:Boolean(existing?.systemProtected),
    officeModel:Boolean(raw?.officeModel ?? existing?.officeModel),
    timeModelVersion:2,
    configured:Boolean(blocks.planning.rows.length || blocks.finkTarget.rows.length || fixedRows.length),
    blocks,
    ...legacy,
    automaticTime:fixedRows.length>0,
    automaticPayrollHours:fixedHours.length && fixedHours.every(v=>Math.abs(v-fixedHours[0])<0.001)?Number(fixedHours[0].toFixed(2)):0,
    payrollReason:fixedRows[0]?.activityLabel||existing?.payrollReason||"",
    projectTimeSource:existing?.projectTimeSource||"actual_stamps"
  };
}
function readModelsSync(){
  try{const parsed=JSON.parse(fs.readFileSync(MODEL_FILE,"utf8"));return Array.isArray(parsed)?parsed:[]}catch{return []}
}
function writeModelsSync(models){fs.mkdirSync(path.dirname(MODEL_FILE),{recursive:true});fs.writeFileSync(MODEL_FILE,JSON.stringify(models,null,2),"utf8")}
function mergeModels(){
  if(!fs.existsSync(MODEL_FILE))return false;
  let models=readModelsSync(),changed=false;
  const prod=models.find(m=>String(m?.id)==="krista-standard");
  if(prod && ["KRISTA-Modell","Produktion · Sommer/Winter","Krista Standard"].includes(String(prod.name||""))){prod.name="Produktive MA";changed=true;}
  for(let i=0;i<models.length;i++){
    const ensured=ensureBlocks(models[i]);
    if(JSON.stringify(ensured)!==JSON.stringify(models[i])){models[i]=ensured;changed=true;}
  }
  for(const preset of OFFICE_MODELS){if(!models.some(m=>String(m?.id)===preset.id)){models.push(preset);changed=true;}}
  if(changed)writeModelsSync(models);
  return true;
}

function installKristineRoutes(){
  try{
    const kristine=require("./kristine");
    const original=kristine.registerKristine;
    if(typeof original!=="function" || original.__kristaWorktimeV2)return;
    const wrapped=function(app,deps){
      const result=original(app,deps);
      const requireAdmin=deps?.requireAdmin;
      const file=path.join(deps?.dataDir||DATA_DIR,"_system","worktime-models.json");
      const allowed=(req,res)=>typeof requireAdmin!=="function"?true:requireAdmin(req,res);
      app.get("/kristine/api/worktime-models-v2",async(req,res)=>{
        if(!allowed(req,res))return;
        try{const parsed=JSON.parse(await fsp.readFile(file,"utf8"));const models=(Array.isArray(parsed)?parsed:[]).map(ensureBlocks);res.json({ok:true,models,source:"worktime-models"});}
        catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
      });
      app.put("/kristine/api/worktime-models-v2",async(req,res)=>{
        if(!allowed(req,res))return;
        try{
          const currentRaw=JSON.parse(await fsp.readFile(file,"utf8").catch(()=>"[]"));
          const current=Array.isArray(currentRaw)?currentRaw:[];
          const byId=new Map(current.map(m=>[String(m?.id||""),m]));
          const incoming=Array.isArray(req.body?.models)?req.body.models.slice(0,100):[];
          const models=incoming.map(m=>cleanModel(m,byId.get(String(m?.id||""))||{})).filter(m=>m.id);
          await fsp.mkdir(path.dirname(file),{recursive:true});
          await fsp.writeFile(file,JSON.stringify(models,null,2),"utf8");
          res.json({ok:true,models,source:"worktime-models"});
        }catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
      });
      return result;
    };
    wrapped.__kristaWorktimeV2=true;
    kristine.registerKristine=wrapped;
  }catch(error){console.error("Zeitmodell-API konnte nicht registriert werden:",error?.message||error)}
}

if(!mergeModels()){
  [1000,5000,15000,45000].forEach(delay=>{const timer=setTimeout(mergeModels,delay);timer.unref?.();});
}
installKristineRoutes();

"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ROOT = path.join(DATA_DIR, "_kristine");
const SYSTEM = path.join(DATA_DIR, "_system");
const CONFIG_FILE = path.join(ROOT, "access-admin.json");
const STATUS_FILE = path.join(ROOT, "access-local-status.json");
const HOLIDAYS_FILE = path.join(SYSTEM, "holidays.json");
const SEED = require("./access-clockwork-seed.js");
const EMPLOYEE_FILES = [path.join(ROOT, "employees.json"), path.join(SYSTEM, "employees.json")];
const PROFILE_IDS = new Set(["1","2","3","4","6"]);
const VERSION = "2026-08-27-access-admin-v1";

function secureEqual(a,b){
  const aa=Buffer.from(String(a||"")),bb=Buffer.from(String(b||""));
  return aa.length===bb.length&&aa.length>0&&crypto.timingSafeEqual(aa,bb);
}
function requireAdmin(req,res){
  if(!ADMIN_TOKEN){res.status(503).json({ok:false,error:"ADMIN_TOKEN fehlt"});return false;}
  const token=String(req.headers["x-admin-token"]||req.query?.token||"");
  if(!secureEqual(token,ADMIN_TOKEN)){res.status(403).json({ok:false,error:"Forbidden"});return false;}
  return true;
}
async function readJson(file,fallback){try{return JSON.parse(await fsp.readFile(file,"utf8"));}catch{return fallback;}}
async function writeJson(file,value){
  await fsp.mkdir(path.dirname(file),{recursive:true});
  const tmp=file+".tmp";
  await fsp.writeFile(tmp,JSON.stringify(value,null,2),"utf8");
  await fsp.rename(tmp,file);
}
function unwrap(value,keys=[]){
  if(Array.isArray(value))return value;
  for(const key of keys)if(Array.isArray(value?.[key]))return value[key];
  return [];
}
function nowIso(){return new Date().toISOString();}
function localDate(){
  const p=Object.fromEntries(new Intl.DateTimeFormat("de-AT",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function normalizeName(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function tokens(v){
  const noise=new Set(["neu","neue","test","uhr","defekt","reserve","safe","2020","2026"]);
  return new Set(normalizeName(v).split(/\s+/).filter(x=>x.length>=3&&!noise.has(x)&&x!=="ex").map(x=>x==="alex"?"alexander":x));
}
function nameScore(a,b){
  const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
  let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/Math.max(A.size,B.size);
}
function employeeName(e){return String(e?.name||e?.employeeName||[e?.firstName,e?.lastName].filter(Boolean).join(" ")||e?.displayName||"").trim();}
function employeeId(e){return String(e?.id||e?.employeeId||e?.personnelNumber||e?.personnelNo||e?.number||"").trim();}
function employeeActive(e){
  if(typeof e?.active==="boolean")return e.active;
  if(typeof e?.isActive==="boolean")return e.isActive;
  const status=normalizeName(e?.status||e?.employmentStatus||e?.state||"");
  if(/inaktiv|inactive|austritt|ausgetreten|archiv|terminated|left/.test(status))return false;
  const end=String(e?.employmentEnd||e?.endDate||e?.exitDate||e?.austritt||"").slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}$/.test(end)&&end<=localDate())return false;
  return true;
}
async function readEmployees(){
  const map=new Map();
  for(const file of EMPLOYEE_FILES){
    const raw=await readJson(file,[]);
    for(const row of unwrap(raw,["employees","rows","items"])){
      const id=employeeId(row),name=employeeName(row);if(!id&&!name)continue;
      const key=id||normalizeName(name);map.set(key,{...map.get(key),...row});
    }
  }
  return [...map.values()].map(row=>({id:employeeId(row),name:employeeName(row),active:employeeActive(row)})).filter(x=>x.id||x.name).sort((a,b)=>a.name.localeCompare(b.name,"de"));
}
function appendHistory(cfg,row){
  cfg.history=Array.isArray(cfg.history)?cfg.history:[];
  cfg.history.unshift({at:nowIso(),...row});
  cfg.history=cfg.history.slice(0,500);
}
function defaultGroupRules(group){
  const p=group.legacyTimeplans||{};
  return {terminals:{"1":String(p["1"]||"1"),"2":String(p["2"]||"1"),"3":String(p["3"]||"1")}};
}
async function seedConfig(){
  const seed={
    source:SEED.source,
    profileCatalog:SEED.profileCatalog||{},
    groups:(SEED.groups||[]).map(r=>({id:String(r[0]),name:String(r[1]),legacyTimeplans:{"1":String(r[2]),"2":String(r[3]),"3":String(r[4])}})),
    chips:(SEED.chips||[]).map(r=>({legacyEmployeeNo:String(r[0]),internalChipNo:String(r[1]),hardwareId:String(r[2]),legacyName:String(r[3]),groupId:String(r[4]),status:String(r[5]),employeeId:"",employeeName:""}))
  };
  const cfg={
    version:1,
    source:seed.source||"clockWORK",
    importedAt:nowIso(),
    revision:1,
    hardwareWriteEnabled:false,
    profileCatalog:seed.profileCatalog||{},
    groups:(seed.groups||[]).map(g=>({...g,rules:defaultGroupRules(g)})),
    chips:(seed.chips||[]).map(c=>({...c,updatedAt:null})),
    pendingSync:null,
    history:[]
  };
  appendHistory(cfg,{type:"import",actor:"System",detail:`clockWORK-Import: ${cfg.chips.length} Chips · ${cfg.groups.length} Gruppen`});
  await writeJson(CONFIG_FILE,cfg);
  return cfg;
}
async function readConfig(){
  let cfg=await readJson(CONFIG_FILE,null);
  if(!cfg)return seedConfig();
  cfg.groups=Array.isArray(cfg.groups)?cfg.groups:[];
  cfg.chips=Array.isArray(cfg.chips)?cfg.chips:[];
  cfg.history=Array.isArray(cfg.history)?cfg.history:[];
  cfg.profileCatalog=cfg.profileCatalog||SEED.profileCatalog||{};
  for(const g of cfg.groups)if(!g.rules)g.rules=defaultGroupRules(g);
  return cfg;
}
async function saveConfig(cfg){cfg.revision=Number(cfg.revision||0)+1;await writeJson(CONFIG_FILE,cfg);return cfg;}
function effectiveChip(chip,groups,employees){
  const group=groups.find(g=>String(g.id)===String(chip.groupId))||null;
  const employee=chip.employeeId?employees.find(e=>String(e.id)===String(chip.employeeId)):null;
  let suggestion=null;
  if(!employee&&!chip.employeeId&&chip.legacyName){
    const ranked=employees.map(e=>({e,score:nameScore(chip.legacyName,e.name)})).filter(x=>x.score>=0.66).sort((a,b)=>b.score-a.score);
    if(ranked.length===1||ranked[0]?.score>ranked[1]?.score)suggestion=ranked[0]?.e||null;
  }
  const terminalProfiles=group?.rules?.terminals||group?.legacyTimeplans||{};
  const groupAllows=Object.values(terminalProfiles).some(v=>String(v)!=="1");
  const chipState=String(chip.status||"active");
  const effectiveAllowed=chipState==="active"&&groupAllows&&(!employee||employee.active!==false);
  return {...chip,groupName:group?.name||"?",employee:employee||null,suggestedEmployee:suggestion,effectiveAllowed,blockedByEmployee:Boolean(employee&&employee.active===false)};
}
async function holidayInfo(){
  const raw=await readJson(HOLIDAYS_FILE,[]),rows=unwrap(raw,["holidays","rows","items"]),today=localDate();
  const future=rows.map(x=>String(x?.date||x?.day||"").slice(0,10)).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&x>=today).sort();
  return {count:rows.length,next:future[0]||null,source:"KRISTINE / _system/holidays.json"};
}
async function bootstrapPayload(){
  const [cfg,employees,holidays,status]=await Promise.all([readConfig(),readEmployees(),holidayInfo(),readJson(STATUS_FILE,null)]);
  const groups=cfg.groups.map(g=>({...g,rules:g.rules||defaultGroupRules(g)}));
  return {ok:true,version:VERSION,revision:cfg.revision,hardwareWriteEnabled:cfg.hardwareWriteEnabled===true,source:cfg.source,profileCatalog:cfg.profileCatalog||{},groups,chips:cfg.chips.map(c=>effectiveChip(c,groups,employees)),employees,holidays,history:cfg.history.slice(0,150),pendingSync:cfg.pendingSync||null,accessStatus:status};
}
function queueSync(cfg,reason,entity){
  cfg.pendingSync={id:`sync_${Date.now()}`,requestedAt:nowIso(),reason,entity,revision:Number(cfg.revision||0)+1,state:"waiting_for_hardware_test"};
}
function pageRedirect(req,res){
  const token=String(req.query?.token||"");
  res.redirect(302,`/public/access-admin.html${token?`?token=${encodeURIComponent(token)}`:""}`);
}
function installRoutes(app){
  if(!app||app.__kristaAccessAdminInstalled)return;
  app.__kristaAccessAdminInstalled=true;
  app.get("/admin/access",(req,res)=>{if(!requireAdmin(req,res))return;pageRedirect(req,res)});
  app.get("/admin/api/access/bootstrap",async(req,res)=>{if(!requireAdmin(req,res))return;try{res.json(await bootstrapPayload())}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});
  app.put("/admin/api/access/chips/:chipNo",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const cfg=await readConfig(),chip=cfg.chips.find(x=>String(x.internalChipNo)===String(req.params.chipNo));
      if(!chip)return res.status(404).json({ok:false,error:"Chip nicht gefunden"});
      const before={groupId:chip.groupId,status:chip.status,employeeId:chip.employeeId,employeeName:chip.employeeName};
      if(Object.prototype.hasOwnProperty.call(req.body||{},"groupId")){
        const gid=String(req.body.groupId||"");if(!cfg.groups.some(g=>String(g.id)===gid))return res.status(400).json({ok:false,error:"Gruppe unbekannt"});chip.groupId=gid;
      }
      if(Object.prototype.hasOwnProperty.call(req.body||{},"status")){
        const status=String(req.body.status||"");if(!["active","reserve","inactive","lost"].includes(status))return res.status(400).json({ok:false,error:"Status ungültig"});chip.status=status;
      }
      if(Object.prototype.hasOwnProperty.call(req.body||{},"employeeId")){
        const employees=await readEmployees(),eid=String(req.body.employeeId||""),emp=eid?employees.find(e=>String(e.id)===eid):null;
        chip.employeeId=eid;chip.employeeName=emp?.name||"";
      }
      chip.updatedAt=nowIso();
      appendHistory(cfg,{type:"chip",actor:"KRISADMIN",detail:`Chip ${chip.internalChipNo} · ${chip.legacyName}: ${before.groupId}/${before.status} → ${chip.groupId}/${chip.status}${chip.employeeName?` · ${chip.employeeName}`:""}`});
      queueSync(cfg,"Chip geändert",{type:"chip",id:String(chip.internalChipNo)});
      await saveConfig(cfg);res.json({ok:true,chip,pendingSync:cfg.pendingSync});
    }catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}
  });
  app.put("/admin/api/access/groups/:id",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const cfg=await readConfig(),group=cfg.groups.find(x=>String(x.id)===String(req.params.id));if(!group)return res.status(404).json({ok:false,error:"Gruppe nicht gefunden"});
      if(Object.prototype.hasOwnProperty.call(req.body||{},"name"))group.name=String(req.body.name||group.name).trim().slice(0,60)||group.name;
      const terminals=req.body?.terminals;if(terminals&&typeof terminals==="object"){
        group.rules=group.rules||defaultGroupRules(group);group.rules.terminals=group.rules.terminals||{};
        for(const term of ["1","2","3"]){if(Object.prototype.hasOwnProperty.call(terminals,term)){const p=String(terminals[term]);if(!PROFILE_IDS.has(p))return res.status(400).json({ok:false,error:`Zeitprofil ${p} nicht freigegeben`});group.rules.terminals[term]=p;}}
      }
      appendHistory(cfg,{type:"group",actor:"KRISADMIN",detail:`Gruppe ${group.id} · ${group.name} geändert`});
      queueSync(cfg,"Gruppe geändert",{type:"group",id:String(group.id)});await saveConfig(cfg);res.json({ok:true,group,pendingSync:cfg.pendingSync});
    }catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}
  });
  app.post("/admin/api/access/sync/request",async(req,res)=>{if(!requireAdmin(req,res))return;try{const cfg=await readConfig();queueSync(cfg,"Manuelle Synchronisierung",{type:"all"});appendHistory(cfg,{type:"sync",actor:"KRISADMIN",detail:"GAT-Synchronisierung angefordert (Testfreigabe noch gesperrt)"});await saveConfig(cfg);res.json({ok:true,pendingSync:cfg.pendingSync,hardwareWriteEnabled:false})}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});
  app.get("/admin/api/access/pending",async(req,res)=>{if(!requireAdmin(req,res))return;try{const p=await bootstrapPayload();res.json({ok:true,revision:p.revision,pendingSync:p.pendingSync,hardwareWriteEnabled:p.hardwareWriteEnabled,groups:p.groups,chips:p.chips.map(c=>({internalChipNo:c.internalChipNo,legacyEmployeeNo:c.legacyEmployeeNo,hardwareId:c.hardwareId,legacyName:c.legacyName,groupId:c.groupId,status:c.status,employeeId:c.employeeId,employeeName:c.employeeName,effectiveAllowed:c.effectiveAllowed,blockedByEmployee:c.blockedByEmployee})),holidays:p.holidays})}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});
  console.log("KRISADMIN Zutritt V1 aktiv");
}

const expressPath=require.resolve("express"),originalExpress=require(expressPath);
function wrappedExpress(...args){
  const app=originalExpress(...args),originalUse=app.use.bind(app);let inserted=false;
  app.use=function(...useArgs){const result=originalUse(...useArgs);if(!inserted){inserted=true;installRoutes(app)}return result};
  return app;
}
Object.assign(wrappedExpress,originalExpress);wrappedExpress.application=originalExpress.application;wrappedExpress.request=originalExpress.request;wrappedExpress.response=originalExpress.response;
require.cache[expressPath].exports=wrappedExpress;
module.exports={installRoutes};

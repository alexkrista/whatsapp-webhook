"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || "").trim();
const CHEF_PHONE = String(process.env.CHEF_PHONE || "").trim();
const TZ = "Europe/Vienna";
const ROOT = path.join(DATA_DIR, "_kristine");
const STATUS_FILE = path.join(ROOT, "access-local-status.json");

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) { res.status(503).json({ok:false,error:"ADMIN_TOKEN fehlt"}); return false; }
  const token = String(req.headers["x-admin-token"] || req.query?.token || "");
  if (!secureEqual(token, ADMIN_TOKEN)) { res.status(403).json({ok:false,error:"Forbidden"}); return false; }
  return true;
}
async function ensureRoot(){ await fsp.mkdir(ROOT,{recursive:true}); }
async function readJson(file,fallback){ try{return JSON.parse(await fsp.readFile(file,"utf8"));}catch{return fallback;} }
async function writeJson(file,value){ await ensureRoot(); await fsp.writeFile(file,JSON.stringify(value,null,2),"utf8"); }

function localDateISO(date=new Date()){
  const p=Object.fromEntries(new Intl.DateTimeFormat("de-AT",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function normalizeName(value){
  return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function personPresence(events,firstName,date){
  const wanted=normalizeName(firstName), relevant=new Set(["start","weiter","pause","mittag","ende"]);
  let last=null;
  for(const row of Array.isArray(events)?events:[]){
    if(String(row?.date||"").slice(0,10)!==date) continue;
    const first=normalizeName(row?.employeeName||"").split(/\s+/)[0]||"";
    if(first!==wanted) continue;
    const type=String(row?.type||"").toLowerCase();
    if(relevant.has(type)) last=row;
  }
  return {
    present:Boolean(last&&String(last.type||"").toLowerCase()!=="ende"),
    name:String(last?.employeeName||firstName),
    lastType:String(last?.type||""),
    lastAt:String(last?.at||""),
    employeeId:String(last?.employeeId||"")
  };
}
function normalizePhone(value){
  let digits=String(value||"").replace(/\D/g,"");
  if(digits.startsWith("00")) digits=digits.slice(2);
  if(digits.startsWith("0")) digits=`43${digits.slice(1)}`;
  return digits;
}
function rememberedSenderId(){
  const direct=String(process.env.PHONE_NUMBER_ID||process.env.WHATSAPP_PHONE_NUMBER_ID||process.env.KRISTINE_PHONE_NUMBER_ID||"").trim();
  if(direct) return direct;
  try{return String(JSON.parse(fs.readFileSync(path.join(ROOT,"whatsapp-sender.json"),"utf8"))?.phoneNumberId||"").trim();}catch{return "";}
}
async function sendChefWhatsApp(message){
  if(!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN fehlt");
  const senderId=rememberedSenderId(), to=normalizePhone(CHEF_PHONE);
  if(!senderId) throw new Error("WhatsApp phone_number_id fehlt");
  if(!to) throw new Error("CHEF_PHONE fehlt");
  const response=await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(senderId)}/messages`,{
    method:"POST",
    headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify({messaging_product:"whatsapp",to,type:"text",text:{preview_url:false,body:String(message||"").slice(0,3500)}})
  });
  if(!response.ok){const body=await response.text().catch(()=> "");throw new Error(`WhatsApp HTTP ${response.status}: ${body.slice(0,500)}`);}
}
function retiredService(key,service){
  const label=normalizeName(service?.label||key);
  return label==="wlan wachter"||label==="wlan waechter"||label.includes("wlan wachter")||label.includes("wlan waechter");
}
async function statusPayload(){
  const row=await readJson(STATUS_FILE,null);
  if(!row) return {ok:true,online:false,stale:true,ageSeconds:null,services:{cloud:{label:"KRISTINE Cloud / Render",state:"ok",detail:"Diese Seite läuft"}},gantner:null};
  const received=Date.parse(row.receivedAt||"");
  const ageSeconds=Number.isFinite(received)?Math.max(0,Math.round((Date.now()-received)/1000)):999999;
  const services={...(row.services||{})};
  for(const [key,service] of Object.entries(services)){
    if(retiredService(key,service)) delete services[key];
  }
  services.cloud={label:"KRISTINE Cloud / Render",state:"ok",detail:"Status-API erreichbar"};
  return {ok:true,...row,services,online:ageSeconds<=40,stale:ageSeconds>40,ageSeconds};
}
function systemStatusHtml(){
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KRISADMIN · Systemstatus</title><link rel="stylesheet" href="/public/ui/krista-ui.css">
<style>
body{margin:0;background:#f5f4ef;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#252925}
main{max-width:1320px;margin:24px auto;padding:0 18px 50px}.head{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:18px}.head h1{margin:0}.sub{color:#6f756f;font-size:13px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{background:#fffefa;border:1px solid #ddd9cf;border-radius:15px;padding:15px;box-shadow:0 6px 20px rgba(23,33,27,.06)}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.name{font-weight:900}.dot{width:14px;height:14px;border-radius:50%}.ok{background:#2f7d4a}.warn{background:#c98428}.bad{background:#a84540}.muted{color:#6f756f;font-size:12px;line-height:1.4;margin-top:8px}
.doors{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 18px}.door{background:#fffefa;border:1px solid #ddd9cf;border-radius:14px;padding:14px;font-weight:900}
@media(max-width:850px){.grid,.doors{grid-template-columns:1fr}}
</style></head><body><div id="kristaTopbar" data-krista-active="krisadmin"></div>
<main><div class="krista-module-nav"><a href="/public/baustellen.html">← KRISADMIN</a><a class="active" href="#">Systemstatus</a></div>
<div class="head"><div><h1>Systemstatus</h1><div class="sub" id="overall">Prüfe …</div></div><button onclick="load()">Neu prüfen</button></div>
<div class="doors" id="doors"></div><div class="grid" id="services"></div></main><script src="/public/ui/topbar.js"></script>
<script>
const token=new URLSearchParams(location.search).get("token")||"";
function esc(v){return String(v??"").replace(/[&<>\"]/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[s]))}
function cls(v){return v==="ok"?"ok":v==="warn"?"warn":"bad"}
async function load(){try{
 const r=await fetch("/kristine/api/access-status?token="+encodeURIComponent(token),{cache:"no-store"}),d=await r.json(),vals=Object.values(d.services||{});
 const bad=!d.online||vals.some(x=>x?.state==="bad"),warn=!bad&&vals.some(x=>x?.state==="warn");
 document.getElementById("overall").textContent=(bad?"🔴 Fehler":warn?"🟡 Warnung":"🟢 Alles OK")+" · PC-Kontakt "+(d.ageSeconds??"-")+" s";
 const doors=d.gantner?.doors||{},labels={1:"Eingang",2:"Lager",3:"Büro"};
 document.getElementById("doors").innerHTML=[1,2,3].map(n=>{const x=doors[String(n)]||{};return '<div class="door">'+(x.mode==="OPEN"?"🟢":"🔴")+' '+labels[n]+'<div class="muted">'+esc(x.mode==="OPEN"?"generell offen":"Normalbetrieb")+(x.override?' · Override '+esc(x.override):"")+' · '+esc(x.reason||"")+'</div></div>'}).join("");
 document.getElementById("services").innerHTML=Object.entries(d.services||{}).map(([k,x])=>'<div class="card"><div class="row"><div class="name">'+esc(x.label||k)+'</div><span class="dot '+cls(x.state)+'"></span></div><div class="muted">'+esc(x.detail||"")+'</div></div>').join("");
}catch(e){document.getElementById("overall").textContent="🔴 Status nicht erreichbar: "+e.message}}
load();setInterval(load,10000);
</script></body></html>`;
}
function installRoutes(app){
  if(!app||app.__kristaAccessBridgeInstalled)return;
  app.__kristaAccessBridgeInstalled=true;
  app.get("/kristine/api/access-presence",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{
      const date=String(req.query?.date||localDateISO()).slice(0,10),events=await readJson(path.join(ROOT,"time-events.json"),[]);
      res.json({ok:true,date,people:{bettina:personPresence(events,"Bettina",date),dunja:personPresence(events,"Dunja",date)},generatedAt:new Date().toISOString()});
    }catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
  });
  app.post("/kristine/api/access-notify",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{const message=String(req.body?.message||"").trim();if(!message)return res.status(400).json({ok:false,error:"message fehlt"});await sendChefWhatsApp(message);res.json({ok:true});}
    catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
  });
  app.post("/kristine/api/access-heartbeat",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{await writeJson(STATUS_FILE,{...(req.body||{}),receivedAt:new Date().toISOString()});res.json({ok:true});}
    catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
  });
  app.get("/kristine/api/access-status",async(req,res)=>{
    if(!requireAdmin(req,res))return;
    try{res.json(await statusPayload())}catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
  });
  app.get("/admin/systemstatus",(req,res)=>{if(!requireAdmin(req,res))return;res.type("html").send(systemStatusHtml())});
  console.log("KRISTINE Zutritt Cloud Bridge V3 aktiv");
}
const expressPath=require.resolve("express"),originalExpress=require(expressPath);
function wrappedExpress(...args){
  const app=originalExpress(...args),originalUse=app.use.bind(app);let inserted=false;
  app.use=function(...useArgs){const result=originalUse(...useArgs);if(!inserted){inserted=true;installRoutes(app)}return result};return app;
}
Object.assign(wrappedExpress,originalExpress);wrappedExpress.application=originalExpress.application;wrappedExpress.request=originalExpress.request;wrappedExpress.response=originalExpress.response;
require.cache[expressPath].exports=wrappedExpress;
module.exports={installRoutes,personPresence};

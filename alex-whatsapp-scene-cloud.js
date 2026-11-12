"use strict";
// Exact WhatsApp commands for the owner. This module never calls doors or lights.
// Only the trusted local Access Bridge can claim the short-lived command.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const COMMANDS = new Map([
  ["alex kommt","arrive"], ["alex komme","arrive"], ["alex ist da","arrive"],
  ["alex bin da","arrive"], ["alex geht","away"], ["alex gehe","away"],
  ["alex fährt","away"], ["alex faehrt","away"], ["alex ist weg","away"],
]);
function parseCommand(input) {
  const value=String(input||"").trim().toLocaleLowerCase("de")
    .replace(/[.!?]+$/,"").replace(/\s+/g," ");
  return COMMANDS.get(value)||null;
}
function normalizePhone(input) {
  let digits=String(input||"").replace(/\D/g,"");
  if(digits.startsWith("00"))digits=digits.slice(2);
  if(digits.startsWith("0"))digits="43"+digits.slice(1);
  return digits;
}
function isOwner(sender, chefPhone) {
  const wanted=normalizePhone(chefPhone),actual=normalizePhone(sender);
  return wanted.length>=10 && actual.length>=10 && actual===wanted;
}
function safeString(value, max=200){return String(value||"").slice(0,max);}
function verifyMetaSignature(rawBody, header, appSecret){
  if(!Buffer.isBuffer(rawBody)||!appSecret)return false;
  const value=String(header||"").trim().toLowerCase();
  if(!/^sha256=[0-9a-f]{64}$/.test(value))return false;
  const expected=crypto.createHmac("sha256",String(appSecret)).update(rawBody).digest();
  const provided=Buffer.from(value.slice(7),"hex");
  return provided.length===expected.length && crypto.timingSafeEqual(provided,expected);
}
function parseConfirmation(text){
  const match=String(text||"").trim().match(/^alex\s+freigeben\s+([0-9a-f]{24})[.!?]?$/i);
  return match?match[1].toLowerCase():null;
}

function createAlexSceneQueue({dataDir,sendReply=async()=>{},now=()=>Date.now()}={}) {
  if(!dataDir)throw Error("dataDir fehlt");
  const file=path.join(dataDir,"_kristine","alex-whatsapp-scenes.json");
  let chain=Promise.resolve();
  function serial(fn){const result=chain.then(fn);chain=result.catch(()=>{});return result;}
  async function read(){
    try{
      const parsed=JSON.parse(await fs.readFile(file,"utf8"));
      if(!Array.isArray(parsed.jobs))throw Error("Szenenarchiv beschädigt");
      return parsed;
    }catch(error){
      if(error.code==="ENOENT")return {jobs:[]};
      throw error; // corrupted history must never reset idempotency
    }
  }
  async function write(data) {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temp=file+"."+process.pid+"."+crypto.randomBytes(4).toString("hex")+".tmp";
    await fs.writeFile(temp,JSON.stringify(data,null,2),"utf8");
    await fs.rename(temp,file);
  }
  function housekeeping(data){
    const time=now();let changed=false;
    for(const item of data.jobs){
      if(["pending","awaiting_confirmation"].includes(item.state) && Date.parse(item.expiresAt)<time){
        item.state="expired";item.updatedAt=new Date(time).toISOString();changed=true;
      }
      if(item.state==="claimed" && Date.parse(item.claimedAt)+90_000<time){
        item.state="uncertain";item.updatedAt=new Date(time).toISOString();changed=true;
      }
    }
    if(data.jobs.length>3000){data.jobs=data.jobs.slice(-3000);changed=true;}
    return changed;
  }
  async function bridgeAvailable(){
    try{
      const status=JSON.parse(await fs.readFile(path.join(dataDir,"_kristine","access-local-status.json"),"utf8"));
      const time=Date.parse(status.receivedAt||"");
      const worker=Date.parse(status.alexSceneWorker?.lastPollAt||"");
      return Number.isFinite(time) && now()-time>=0 && now()-time<75_000 &&
        Number.isFinite(worker) && now()-worker>=0 && now()-worker<45_000 &&
        status.alexSceneWorker?.version==="alex-wa-v1" &&
        status.services?.gantner?.state==="ok";
    }catch{return false;}
  }
  async function enqueue({sender,chefPhone,command,messageId,timestamp,phoneNumberId}) {
    if(!isOwner(sender,chefPhone))return {status:"unauthorized"};
    const action=parseCommand(command);
    if(!action)return {status:"unknown"};
    const sentAt=Number(timestamp)*1000;
    if(!Number.isFinite(sentAt)||!sentAt||Math.abs(now()-sentAt)>180_000)
      return {status:"stale"};
    const message=String(messageId||"").trim();
    if(!/^[A-Za-z0-9._:+/=-]{12,250}$/.test(message))return {status:"unverified"};
    const key=crypto.createHash("sha256").update(message).digest("hex");
    return serial(async()=>{
      const data=await read();housekeeping(data);
      const existing=data.jobs.find(x=>x.messageKey===key);
      if(existing)return {status:"duplicate",action,state:existing.state};
      if(!await bridgeAvailable())return {status:"offline"};
      if(data.jobs.some(x=>["pending","claimed","awaiting_confirmation"].includes(x.state)))return {status:"busy"};
      const createdAt=new Date(now()).toISOString();
      const job={id:"alexscene_"+crypto.randomBytes(12).toString("hex"),
        messageKey:key,action,createdAt,expiresAt:new Date(now()+120_000).toISOString(),
        updatedAt:createdAt,state:"pending",sender:normalizePhone(sender),
        phoneNumberId:safeString(phoneNumberId,100)};
      data.jobs.push(job);await write(data);
      return {status:"queued",action,id:job.id};
    });
  }
  async function challenge({sender,chefPhone,command,messageId,timestamp,phoneNumberId}) {
    if(!isOwner(sender,chefPhone))return {status:"unauthorized"};
    const action=parseCommand(command),sent=Number(timestamp)*1000;
    if(!action)return {status:"unknown"};
    if(!Number.isFinite(sent)||!sent||Math.abs(now()-sent)>180_000)return {status:"stale"};
    const message=String(messageId||"");
    if(!/^[A-Za-z0-9._:+/=-]{12,250}$/.test(message))return {status:"unverified"};
    const key=crypto.createHash("sha256").update(message).digest("hex");
    return serial(async()=>{
      const data=await read();housekeeping(data);
      if(data.jobs.some(x=>x.messageKey===key))return {status:"duplicate"};
      if(!await bridgeAvailable())return {status:"offline"};
      if(data.jobs.some(x=>["pending","claimed","awaiting_confirmation"].includes(x.state)))return {status:"busy"};
      const code=crypto.randomBytes(12).toString("hex");
      const stamp=new Date(now()).toISOString();
      const job={id:"alexscene_"+crypto.randomBytes(12).toString("hex"),messageKey:key,
        action,createdAt:stamp,updatedAt:stamp,expiresAt:new Date(now()+120_000).toISOString(),
        state:"awaiting_confirmation",sender:normalizePhone(sender),
        phoneNumberId:safeString(phoneNumberId,100),
        challengeDigest:crypto.createHash("sha256").update(code).digest("hex"),attempts:0};
      data.jobs.push(job);await write(data);
      return {status:"challenge",code,action};
    });
  }
  async function confirm({sender,chefPhone,command,messageId,timestamp,phoneNumberId}){
    if(!isOwner(sender,chefPhone))return {status:"unauthorized"};
    const code=parseConfirmation(command),sent=Number(timestamp)*1000;
    if(!code)return {status:"unknown"};
    if(!Number.isFinite(sent)||!sent||Math.abs(now()-sent)>180_000)return {status:"stale"};
    const message=String(messageId||"");
    if(!/^[A-Za-z0-9._:+/=-]{12,250}$/.test(message))return {status:"unverified"};
    const key=crypto.createHash("sha256").update(message).digest("hex");
    return serial(async()=>{
      const data=await read();housekeeping(data);
      if(data.jobs.some(x=>x.confirmationMessageKey===key))return {status:"duplicate"};
      const job=[...data.jobs].reverse().find(x=>x.state==="awaiting_confirmation" &&
        x.sender===normalizePhone(sender));
      if(!job)return {status:"no_challenge"};
      const actual=Buffer.from(crypto.createHash("sha256").update(code).digest("hex"),"hex");
      const expected=Buffer.from(job.challengeDigest,"hex");
      if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)){
        job.attempts=Number(job.attempts||0)+1;
        if(job.attempts>=3)job.state="rejected";
        await write(data);
        return {status:"invalid_code"};
      }
      if(!await bridgeAvailable()){
        job.state="expired";await write(data);return {status:"offline"};
      }
      job.state="pending";job.confirmationMessageKey=key;
      job.updatedAt=new Date(now()).toISOString();
      job.expiresAt=new Date(now()+120_000).toISOString();
      job.phoneNumberId=safeString(phoneNumberId,100);
      delete job.challengeDigest;delete job.attempts;
      await write(data);
      return {status:"queued",action:job.action,id:job.id};
    });
  }
  async function claim(){
    return serial(async()=>{
      const data=await read();const changed=housekeeping(data);
      const job=data.jobs.find(x=>x.state==="pending");
      if(!job){if(changed)await write(data);return null;}
      job.state="claimed";job.claimedAt=new Date(now()).toISOString();job.updatedAt=job.claimedAt;
      await write(data);
      return {id:job.id,action:job.action,expiresAt:job.expiresAt};
    });
  }
  async function ack({id,ok,detail,doors,alex,bettina,dunja,light}={}){
    return serial(async()=>{
      const data=await read();
      const job=data.jobs.find(x=>x.id===id);
      if(!job||job.state!=="claimed")return {ok:false,notFound:true};
      job.state=ok===true?"done":"failed";
      job.updatedAt=new Date(now()).toISOString();
      job.detail=safeString(detail,240);
      job.result={doors:Object.fromEntries([1,2,3].map(n=>[String(n),safeString(doors?.[String(n)],12)])),
        alex:alex===true,bettina:bettina===true,dunja:dunja===true,light:safeString(light,40)};
      await write(data);
      const result=job.result;
      const allOpen=Object.values(result.doors).every(x=>x==="OPEN");
      const allNormal=Object.values(result.doors).every(x=>x==="NORMAL");
      const officeStillHere=result.bettina||result.dunja;
      let reply;
      if(job.state!=="done"){
        reply="⚠️ Alex "+(job.action==="arrive"?"kommt":"geht")+": nicht bestätigt. "+(job.detail||"Bitte Systemstatus prüfen.");
      } else if(job.action==="arrive"){
        reply=allOpen
          ?"✅ Alex kommt: GANTNER-Türen freigegeben. "+
            (result.light==="switched_on"||result.light==="already_on"
              ?"Stiegenhauslicht ist EIN."
              :result.light==="weekend_automatic_only"
                ?"Am Wochenende wird das Stiegenhauslicht nicht automatisch geschaltet."
                :"Stiegenhauslicht: bestehende Automatik / Status vor Ort prüfen.")
          :"⚠️ Alex kommt: Befehl verarbeitet, aber keine Freigabe aller Türen bestätigt (z. B. nach 18 Uhr). Bitte Türstatus prüfen.";
      } else {
        reply=officeStillHere
          ?"✅ Alex geht: als abwesend gemeldet. Bettina/Dunja noch anwesend – Türen und Stiegenhauslicht bleiben nach deren Regeln geschaltet."
          :allNormal
            ?"✅ Alex geht: GANTNER-Türen im Normalbetrieb. Stiegenhauslicht geht nach dem bestehenden sicheren Anwesenheits-Nachlauf aus."
            :"⚠️ Alex geht: Alex ist abgemeldet, Türenstatus bitte prüfen. Licht wird durch die bestehende Anwesenheitsautomatik gesteuert.";
      }
      try{await sendReply({to:job.sender,phoneNumberId:job.phoneNumberId,reply});}
      catch(error){console.error("ALEX_SCENE_WHATSAPP_RESULT_FAILED",String(error?.message||error).slice(0,150));}
      return {ok:true,state:job.state};
    });
  }
  function installRoutes(app,requireAdmin){
    if(!app||typeof requireAdmin!=="function")throw Error("Access-Bridge-Adminauth fehlt");
    app.get("/kristine/api/alex-scene/next",async(req,res)=>{
      if(!requireAdmin(req,res,{allowBrowserSession:false}))return;
      try{res.set("Cache-Control","no-store");res.json({ok:true,job:await claim()});}
      catch(error){res.status(500).json({ok:false,error:"Szenenwarteschlange nicht lesbar"});}
    });
    app.post("/kristine/api/alex-scene/ack",async(req,res)=>{
      if(!requireAdmin(req,res,{allowBrowserSession:false}))return;
      try{
        const result=await ack(req.body||{});
        res.status(result.ok?200:409).json(result);
      }catch(error){res.status(500).json({ok:false,error:"Szenenergebnis nicht speicherbar"});}
    });
  }
  return {parseCommand,parseConfirmation,verifyMetaSignature,isOwner,enqueue,challenge,confirm,claim,ack,read,installRoutes};
}
module.exports={parseCommand,parseConfirmation,verifyMetaSignature,isOwner,normalizePhone,createAlexSceneQueue};

"use strict";
const fs=require("fs/promises"),path=require("path");
const TEXT="Info zur Zeiterfassung: Die automatische Buchung ist ausgeschaltet. Bitte ab sofort jede Aktion selbst an KRISTINE per WhatsApp schicken:\n\nStart – Arbeitsbeginn\nMittag – Beginn der Mittagspause\nWeiter – nach der Mittagspause weiterarbeiten\nEnde oder Fertig – Feierabend\n\nNach der Mittagspause bitte Weiter verwenden, nicht Start. Am Freitag bei Arbeitsende ebenfalls Ende oder Fertig senden. Bitte jeweils die Bestätigung von KRISTINE kontrollieren.";
let lastResult={status:"pending"};
async function notify({dataDir,readEmployees,sendWhatsApp,phoneNumberId,now=new Date(),logger=console}){
 if(now.toISOString().slice(0,10)>"2026-11-18")return {expired:true};
 const dir=path.join(dataDir,"_system","manual-stamping-notice-20261117");await fs.mkdir(dir,{recursive:true});
 const employees=await readEmployees(),seen=new Set();let sent=0,failed=0,skipped=0;
 for(const e of Array.isArray(employees)?employees:[]){
  if(!e||e.active===false||e.isTest===true||e.test===true||e.demo===true)continue;
  const to=String(e.phone||"").replace(/\D/g,"");if(to.length<8||seen.has(to))continue;seen.add(to);
  if(/\b(test|demo|dummy)\b/i.test([e.name,e.firstName,e.lastName,e.displayName].filter(Boolean).join(" ")))continue;
  const key=require("crypto").createHash("sha256").update(to).digest("hex"),file=path.join(dir,key+".json");
  try{await fs.writeFile(file,JSON.stringify({employeeId:e.id,status:"dispatching",at:new Date().toISOString()}),{flag:"wx"})}catch(err){if(err.code==="EEXIST"){skipped++;continue}throw err}
  try{await sendWhatsApp({phoneNumberId,to,reply:TEXT,buttons:[],includeGoLink:false,purpose:"manual_stamping_notice_20261117"});await fs.writeFile(file,JSON.stringify({employeeId:e.id,status:"accepted",at:new Date().toISOString()}));sent++}
  catch(err){await fs.writeFile(file,JSON.stringify({employeeId:e.id,status:"failed",at:new Date().toISOString(),error:String(err.message||err).slice(0,300)}));failed++}
 }
 const result={sent,failed,skipped,at:new Date().toISOString()};await fs.writeFile(path.join(dir,"result.json"),JSON.stringify(result));logger.log("MANUAL_STAMPING_NOTICE_RESULT",result);lastResult={status:"complete",...result};return result;
}
module.exports={notify,TEXT,getStatus:()=>lastResult};

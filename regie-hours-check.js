"use strict";
const nameKey=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const minute=s=>/^\d{2}:\d{2}$/.test(String(s||""))?Number(s.slice(0,2))*60+Number(s.slice(3)):null;
function intervalMinutes(rows){const spans=rows.map(r=>[minute(r.from),minute(r.to)]).filter(([a,b])=>a!==null&&b!==null&&b>a).sort((a,b)=>a[0]-b[0]);let total=0,end=-1;for(const [a,b] of spans){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}return total}
function localParts(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return null;const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d).map(x=>[x.type,x.value]));return{date:p.year+"-"+p.month+"-"+p.day,time:p.hour+":"+p.minute}}
function auditReport(report,reports,events,archive,master=[],now=new Date()){
 const key=p=>{const id=String(p.employeeId||p.id||"");const found=master.find(m=>String(m.id)===id)||master.find(m=>[m.name,m.nickname,m.rufname].some(n=>n&&nameKey(n)===nameKey(p.name||p.employeeName)));return String(found?.id||id||nameKey(p.name||p.employeeName))};
 const peers=reports.filter(r=>r.id!==report.id&&String(r.jobId)===String(report.jobId)&&r.date===report.date&&r.status!=="deleted");
 const totals=new Map(),labels=new Map();for(const r of [...peers,report])for(const p of r.employees||[]){const k=key(p);totals.set(k,(totals.get(k)||0)+Number(p.hours||0));labels.set(k,p.name||k)}
 const warnings=[],exceeded=[];let missing=false;
 const dateTime=[localParts(now),localParts(report.submittedAt||report.createdAt)].find(p=>p?.date===report.date);
 const endpoint=dateTime?Math.min(minute(dateTime.time),minute(report.to||report.segment?.to)??1440):null;
 for(const [k,hours] of totals){
  const archived=archive.find(a=>key(a)===k&&a.date===report.date);
  const archivedWork=(archived?.segments||[]).filter(s=>s.type==="work"&&s.jobId&&minute(s.from)!==null&&minute(s.to)!==null&&minute(s.to)>minute(s.from));
  const day=events.filter(e=>key(e)===k&&e.date===report.date&&["start","weiter","resume","up","pause","mittag","ende","fertig","stop","stopp"].includes(String(e.type||e.command).toLowerCase())).sort((a,b)=>String(a.at).localeCompare(String(b.at))||String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
  const live=[];let incomplete=false;
  for(let i=0;i<day.length;i++){const e=day[i];if(!["start","weiter","resume"].includes(String(e.type||e.command).toLowerCase())||!e.jobId)continue;const next=day[i+1];let end=next?.at;if(!end&&endpoint!==null&&endpoint>minute(e.at))end=String(Math.floor(endpoint/60)).padStart(2,"0")+":"+String(endpoint%60).padStart(2,"0");if(!end){incomplete=true;continue}if(minute(end)>minute(e.at))live.push({from:e.at,to:end,jobId:e.jobId})}
  // Empty/detached archives do not prove zero project hours. Use real stamps where available.
  const archiveMatches=archivedWork.filter(s=>String(s.jobId)===String(report.jobId));
  const liveMatches=live.filter(s=>String(s.jobId)===String(report.jobId));
  let spans;
  if(archiveMatches.length)spans=archiveMatches;
  else if(liveMatches.length&&!incomplete)spans=liveMatches;
  else if(incomplete){missing=true;continue}
  else if(archivedWork.length||live.length)spans=[];
  else{missing=true;continue}
  const stampedMinutes=intervalMinutes(spans),limit=Math.ceil(stampedMinutes/15)/4;
  if(hours>limit+0.001)exceeded.push({employee:labels.get(k),hours:Math.round(hours*100)/100,limit,stampedMinutes});
 }
 if(exceeded.length)warnings.push("Möglicherweise doppelt erfasst? "+exceeded.map(x=>x.employee+": "+x.hours+" h Regie, höchstens "+x.limit+" h aus Stempelzeiten einschließlich Viertelstundenrundung").join("; ")+". Bitte Berichte und Zeiten prüfen.");
 if(missing)warnings.push("Stempelzeiten für den Vergleich fehlen oder sind noch offen. Das bedeutet nicht 0 Arbeitsstunden. Bitte Tageszeiten prüfen.");
 return{blocked:exceeded.length>0,warnings,exceeded,relatedReports:peers.map(r=>({id:r.id,number:r.reportNumber,hours:r.totals?.laborHours})),missingTimes:missing};
}
module.exports={auditReport,intervalMinutes};

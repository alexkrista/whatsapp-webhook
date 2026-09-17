"use strict";
const nameKey=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const minute=s=>/^\d{2}:\d{2}$/.test(String(s||''))?Number(s.slice(0,2))*60+Number(s.slice(3)):null;
function intervalMinutes(rows){const spans=rows.map(r=>[minute(r.from),minute(r.to)]).filter(([a,b])=>a!==null&&b!==null&&b>a).sort((a,b)=>a[0]-b[0]);let total=0,end=-1;for(const [a,b] of spans){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}return total;}
function auditReport(report,reports,events,archive,master=[]){
 const key=p=>{const id=String(p.employeeId||p.id||'');const found=master.find(m=>String(m.id)===id)||master.find(m=>[m.name,m.nickname].some(n=>n&&nameKey(n)===nameKey(p.name||p.employeeName)));return String(found?.id||id||nameKey(p.name||p.employeeName));};
 const peers=reports.filter(r=>r.id!==report.id&&r.jobId===report.jobId&&r.date===report.date&&r.status!=='deleted');
 const totals=new Map(),labels=new Map();for(const r of [...peers,report])for(const p of r.employees||[]){const k=key(p);totals.set(k,(totals.get(k)||0)+Number(p.hours||0));labels.set(k,p.name||k)}
 const warnings=[],exceeded=[];let missing=false;
 for(const [k,hours] of totals){
  const archived=archive.find(a=>key(a)===k&&a.date===report.date);
  const day=events.filter(e=>key(e)===k&&e.date===report.date).sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  let spans=[];let known=false;
  if(archived){known=true;spans=(archived.segments||[]).filter(s=>s.type==='work'&&String(s.jobId)===String(report.jobId));}
  else if(day.length){known=true;spans=day.slice(0,-1).flatMap((e,i)=>['start','weiter','resume'].includes(String(e.type||e.command).toLowerCase())&&String(e.jobId)===String(report.jobId)?[{from:e.at,to:day[i+1].at}]:[]);}
  if(!known){missing=true;continue;}
  const stampedMinutes=intervalMinutes(spans),limit=Math.ceil(stampedMinutes/15)/4;
  if(hours>limit+0.001)exceeded.push({employee:labels.get(k),hours:Math.round(hours*100)/100,limit,stampedMinutes});
 }
 if(exceeded.length)warnings.push('Möglicherweise doppelt erfasst? '+exceeded.map(x=>`${x.employee}: ${x.hours} h Regie, höchstens ${x.limit} h aus Stempelzeiten einschließlich Viertelstundenrundung`).join('; ')+'. Bitte Berichte und Zeiten prüfen.');
 if(missing)warnings.push('Stempelzeiten für den Vergleich fehlen teilweise. Bitte Tageszeiten prüfen.');
 return {blocked:exceeded.length>0,warnings,exceeded,relatedReports:peers.map(r=>({id:r.id,number:r.reportNumber,hours:r.totals?.laborHours})),missingTimes:missing};
}
module.exports={auditReport,intervalMinutes};

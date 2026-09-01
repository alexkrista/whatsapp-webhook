"use strict";

(function(){
  const VERSION="2026-09-01-workflow-inbox-3";
  const token=new URLSearchParams(location.search).get("token")||"";
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token&&u.origin===location.origin)u.searchParams.set("token",token);return u.pathname+u.search+u.hash};
  async function api(p){const r=await fetch(tokenUrl(p));const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(v));
  const hours=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(v))+" h";
  let liveByJob=new Map();
  let timer=null;

  function installCss(){if(document.getElementById('towerSignalsCss'))return;const s=document.createElement('style');s.id='towerSignalsCss';s.textContent=`
    .ts-wrap{margin:0 0 12px;border:1px solid #ddd9cf;background:#fffefa;border-radius:16px;padding:14px 15px;box-shadow:0 5px 18px rgba(23,33,27,.045)}.ts-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}.ts-head h2{margin:0;font-size:15px}.ts-head p{margin:3px 0 0;font-size:10.5px;color:#707670}.ts-count{display:inline-flex;border-radius:999px;background:#eef3ee;color:#315b3d;padding:6px 9px;font-size:10px;font-weight:900}.ts-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ts-pane{border:1px solid #e3dfd6;border-radius:12px;background:#f7f5ef;padding:10px;min-width:0}.ts-pane h3{display:flex;justify-content:space-between;margin:0 0 8px;font-size:12px}.ts-pane h3 span{border-radius:999px;background:#fff;padding:2px 7px;font-size:9px}.ts-pane.tasks{border-left:4px solid #3e7198}.ts-pane.offers{border-left:4px solid #755c98}.ts-pane.billing{border-left:4px solid #c98428}.ts-pane.orders{border-left:4px solid #2f7d4a}.ts-item{display:block;background:#fff;border:1px solid #e3dfd6;border-radius:9px;padding:8px;margin-top:6px;text-decoration:none;color:#222}.ts-item strong{display:block;font-size:10.5px}.ts-item small{display:block;color:#707670;font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ts-empty{color:#777;font-size:9.5px;padding:8px}.ts-footer{display:flex;justify-content:flex-end;margin-top:8px}.ts-footer a{font-size:10px;font-weight:850;color:#2f6c40;text-decoration:none}@media(max-width:760px){.ts-grid{grid-template-columns:1fr}.ts-head{flex-direction:column}.ts-count{align-self:flex-start}}
  `;document.head.appendChild(s)}

  function assignments(b){for(const c of [b?.assignments,b?.planning?.assignments,b?.data?.assignments]){if(Array.isArray(c))return c;if(c&&typeof c==='object')return Object.values(c).flat().filter(Boolean)}return[]}
  function aid(a){return String(a?.jobId??a?.siteId??a?.job?.jobId??a?.job?.id??'')}
  function hm(v){const m=String(v||'').match(/^(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
  function ah(a){const e=num(a?.hours??a?.plannedHours??a?.durationHours);if(e>0)return e;const f=hm(a?.from??a?.startTime),t=hm(a?.to??a?.endTime);return f!==null&&t!==null&&t>f?(t-f)/60:0}
  function futureMap(b){const today=new Date().toISOString().slice(0,10),map={};for(const a of assignments(b)){const day=String(a.date||a.day||'').slice(0,10);if(day&&day<today)continue;const id=aid(a);if(!id)continue;map[id]=(map[id]||0)+ah(a)}return map}
  function calc(j){return j?.calculation||{}}
  function target(j){return num(calc(j).calculatedHours)}
  function oldTotal(j){return num(calc(j).actualHours)}
  function oldOrder(j){const c=calc(j);const direct=Number(c.orderHours);return Number.isFinite(direct)?Math.max(0,direct):Math.max(0,oldTotal(j)-num(c.actualRegieHours))}
  function contract(j){return num(j.contractAmount??calc(j).contractAmount)}
  function dateValue(j){return j.offerFollowUpAt||j.offerDate||j.createdAt||j.startDate||j.latestDay||''}
  function ageDays(j){const raw=dateValue(j);if(!raw)return null;const d=new Date(String(raw).slice(0,10)+'T12:00:00');return Number.isNaN(d.getTime())?null:Math.max(0,Math.floor((Date.now()-d.getTime())/86400000))}
  function nowMinutes(){const d=new Date();return d.getHours()*60+d.getMinutes()+d.getSeconds()/60}

  // Exakt dieselbe Stundenquelle wie die Baustellenübersicht:
  // tatsächliche KRISTINE-Zeitereignisse haben Vorrang vor einem älteren Kalkulationsstand.
  function buildLiveMap(b){
    liveByJob=new Map();
    const events=Array.isArray(b?.timeEvents)?b.timeEvents:[];
    const states=b?.states||{};
    const groups=new Map();
    events.forEach((event,index)=>{
      const employeeId=String(event?.employeeId||'');
      const date=String(event?.date||'').slice(0,10);
      const minute=hm(event?.at);
      if(!employeeId||!date||minute===null)return;
      const key=employeeId+'|'+date;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({...event,_index:index,_minute:minute});
    });
    for(const [key,rows] of groups){
      rows.sort((a,b)=>a._minute-b._minute||String(a.createdAt||'').localeCompare(String(b.createdAt||''))||a._index-b._index);
      const [employeeId,date]=key.split('|');
      const state=states?.[employeeId]||{};
      for(let i=0;i<rows.length;i++){
        const row=rows[i];
        if(!['start','weiter'].includes(String(row.type||'').toLowerCase()))continue;
        const jobId=String(row.jobId||'').trim();
        if(!jobId)continue;
        const start=row._minute;
        const next=rows[i+1];
        let end=next?._minute??null;
        if(end===null&&date===String(b?.today||'')&&['working','pause','lunch'].includes(String(state?.mode||'')))end=nowMinutes();
        if(end===null||end<=start)continue;
        const duration=(end-start)/60;
        if(duration<=0||duration>18)continue;
        liveByJob.set(jobId,num(liveByJob.get(jobId))+duration);
      }
    }
  }

  function actual(j){
    const live=num(liveByJob.get(String(j?.jobId||'')));
    const regie=num(calc(j).actualRegieHours);
    return Math.max(oldOrder(j),Math.max(0,live-regie));
  }
  function openHoursFor(j){
    const status=String(j?.status||'');
    const t=target(j),a=actual(j);
    if(status==='Auftrag')return Math.max(0,t);
    if(status==='Laufend')return Math.max(0,t-a);
    // Fertig / geschlossen / Angebote zählen niemals in den Auftragsbestand.
    return 0;
  }

  function patchKpis(jobs,b){
    const totalOpen=jobs.reduce((sum,j)=>sum+openHoursFor(j),0);
    const cap=num(b?.company?.weeklyProductiveHours||b?.company?.weeklyCapacityHours)||312;
    const backlog=document.getElementById('backlog');
    const openHours=document.getElementById('openHours');
    const weeks=document.getElementById('capacityWeeks');
    const note=document.getElementById('capacityNote');
    if(backlog)backlog.textContent=money(totalOpen*90);
    if(openHours)openHours.textContent=hours(totalOpen);
    if(weeks)weeks.textContent=(totalOpen/cap).toLocaleString('de-AT',{maximumFractionDigits:1})+' Wo.';
    if(note)note.textContent=`Basis ${new Intl.NumberFormat('de-AT',{maximumFractionDigits:1}).format(cap)} h / Woche`;
    return {totalOpen,cap};
  }

  function signals(jobs,b){const plan=futureMap(b),rows=[];for(const j of jobs){const id=String(j.jobId),t=target(j),a=actual(j),remaining=openHoursFor(j),p=plan[id]||0,amount=contract(j);if(j.status==='Auftrag'&&p<=0){rows.push({severity:'high',score:100,title:'Auftrag ohne Einteilung',detail:`${j.name||id} · ${hours(t)} Soll noch nicht verplant`,job:j,value:amount?money(amount):hours(t)});continue}if(j.status==='Laufend'&&t>0&&a>t){rows.push({severity:'high',score:95+(a-t),title:'Stunden über Soll · Restaufwand prüfen',detail:`${j.name||id} · ${hours(a)} Ist / ${hours(t)} Soll · Rest niemals negativ`,job:j,value:'+'+hours(a-t)});continue}if(j.status==='Fertig – nicht abgerechnet'){rows.push({severity:'high',score:92,title:'Fertig · Abrechnung offen',detail:`${j.name||id} · Baustelle wartet auf Abrechnung`,job:j,value:amount?money(amount):'prüfen'});continue}if(j.status==='Laufend'&&remaining>0&&p<=0){rows.push({severity:'medium',score:80+remaining/10,title:'Restarbeit ohne Planung',detail:`${j.name||id} · ${hours(remaining)} Reststunden`,job:j,value:hours(remaining)});continue}if(j.status==='Angebot'){const age=ageDays(j);if(age!==null&&age>=14){rows.push({severity:age>=28?'high':'medium',score:50+Math.min(40,age),title:'Angebot nachfassen',detail:`${j.name||id} · ${age} Tage alt`,job:j,value:amount?money(amount):age+' T.'})}}}return rows.sort((x,y)=>y.score-x.score).slice(0,8)}

  function render(rows,workflows=[],tasks=[]){
    const dash=document.querySelector('.dashboard'),main=document.querySelector('body>main');if(!main)return;let wrap=document.getElementById('towerSignals');if(!wrap){wrap=document.createElement('section');wrap.id='towerSignals';wrap.className='ts-wrap';if(dash)main.insertBefore(wrap,dash);else main.appendChild(wrap)}
    const open=workflows.filter(w=>!['offer_draft','order_approved'].includes(w.status)),offers=open.filter(w=>w.target==='offer'),orders=open.filter(w=>w.target==='order'),billing=rows.filter(r=>/abrechn/i.test(r.title)),offerSignals=rows.filter(r=>/angebot/i.test(r.title)),orderSignals=rows.filter(r=>!billing.includes(r)&&!offerSignals.includes(r)),openTasks=tasks.filter(t=>t.status!=='done').slice(0,5);
    const workflowItem=w=>`<a class="ts-item" href="${tokenUrl('/kristine?task='+encodeURIComponent(w.taskId))}#tasks"><strong>${w.title}</strong><small>${w.customer||''} · ${w.address||''}</small></a>`,signalItem=r=>`<a class="ts-item" href="${tokenUrl('/public/baustellen.html')}#${encodeURIComponent(r.job.jobId)}"><strong>${r.title}</strong><small>#${r.job.jobId} · ${r.detail}</small></a>`,taskItem=t=>`<a class="ts-item" href="${tokenUrl('/kristine?task='+encodeURIComponent(t.id))}#tasks"><strong>${t.title}</strong><small>${t.assigneeName||''} · ${t.reminder||''}</small></a>`;
    const pane=(title,kind,items)=>`<section class="ts-pane ${kind}"><h3>${title}<span>${items.length}</span></h3>${items.length?items.slice(0,5).join(''):'<div class="ts-empty">Derzeit nichts offen.</div>'}</section>`;
    wrap.innerHTML=`<div class="ts-head"><div><h2>Heute wichtig</h2><p>Aufgaben, Angebote, Abrechnungen und Auftragsfreigaben auf einen Blick.</p></div><span class="ts-count">${openTasks.length+offers.length+orders.length+rows.length} Signale</span></div><div class="ts-grid">${pane('Aufgaben','tasks',openTasks.map(taskItem))}${pane('Angebote','offers',[...offers.map(workflowItem),...offerSignals.map(signalItem)])}${pane('Abrechnungen','billing',billing.map(signalItem))}${pane('Aufträge','orders',[...orders.map(workflowItem),...orderSignals.map(signalItem)])}</div><div class="ts-footer"><a href="${tokenUrl('/public/baustellen.html')}">Alle Baustellen öffnen →</a></div>`
  }

  async function load(){try{const [j,b,w]=await Promise.all([api('/admin/api/jobs'),api('/kristine/api/bootstrap').catch(()=>({})),api('/kristool/api/workflows').catch(()=>({workflows:[]}))]);const jobs=j.jobs||[];const boot=b||{};buildLiveMap(boot);const kpi=patchKpis(jobs,boot);render(signals(jobs,boot),w.workflows||[],boot.tasks||[]);const legacy=jobs.reduce((sum,row)=>{const c=calc(row);const oldActual=num(c.actualHours??c.orderHours);if(row.status==='Auftrag')return sum+Math.max(0,target(row));if(row.status==='Laufend')return sum+Math.max(0,target(row)-oldActual);return sum},0);window.__kristaTowerHours={live:kpi.totalOpen,legacy,difference:legacy-kpi.totalOpen,updatedAt:new Date().toISOString()};}catch(e){console.warn('Tower Baustellen-Signale',e)}}
  function init(){installCss();load();timer=setInterval(load,60000);window.addEventListener('beforeunload',()=>timer&&clearInterval(timer),{once:true});window.TowerBaustellenSignals={version:VERSION,reload:load,debug:()=>window.__kristaTowerHours||null}}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();

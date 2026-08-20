"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;

  let modelCache=null;
  let modelCacheAt=0;
  let lastKey="";
  let busy=false;

  function withToken(pathname){
    const url=new URL(pathname,location.origin);
    const token=new URLSearchParams(location.search).get("token");
    if(token)url.searchParams.set("token",token);
    return `${url.pathname}${url.search}`;
  }
  function min(hm){
    const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/);
    return m?Number(m[1])*60+Number(m[2]):null;
  }
  function overlap(a1,a2,b1,b2){
    const aa=min(a1),ab=min(a2),ba=min(b1),bb=min(b2);
    if([aa,ab,ba,bb].some(v=>v===null))return 0;
    return Math.max(0,Math.min(ab,bb)-Math.max(aa,ba));
  }
  function netMinutes(row){
    const a=min(row?.from),b=min(row?.to);
    if(a===null||b===null||b<=a)return 0;
    return Math.max(0,b-a-overlap(row.from,row.to,row.pauseFrom,row.pauseTo)-overlap(row.from,row.to,row.lunchFrom,row.lunchTo));
  }
  function durationLabel(minutes){
    const n=Math.max(0,Math.round(Number(minutes)||0));
    return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")} h`;
  }
  function weekday(iso){
    const d=new Date(`${iso}T12:00:00`);
    const n=d.getDay();
    return n===0?7:n;
  }
  function esc(value){
    return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }
  function norm(value){
    return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  }
  async function loadModels(force=false){
    const fresh=Array.isArray(modelCache)&&modelCache.length&&Date.now()-modelCacheAt<5000;
    if(!force&&fresh)return modelCache;
    try{
      const response=await fetch(withToken("/kristine/api/worktime-models-v2"),{credentials:"same-origin",cache:"no-store"});
      const body=await response.json();
      if(response.ok&&body?.ok!==false&&Array.isArray(body?.models)){
        modelCache=body.models;
        modelCacheAt=Date.now();
      }
    }catch{}
    return Array.isArray(modelCache)?modelCache:[];
  }
  function employee(){
    try{
      if(typeof currentEmployeeMaster==="function"){
        const row=currentEmployeeMaster();
        if(row)return row;
      }
    }catch{}
    try{
      const id=String(state?.activeEmployeeId||document.getElementById("employeeSelect")?.value||"");
      return (state?.bootstrap?.employees||[]).find(row=>String(row?.id||row?.employeeId||"")===id)||null;
    }catch{return null}
  }
  function expectedOfficeModelId(emp){
    const name=norm([emp?.nickname,emp?.name,emp?.employeeName].filter(Boolean).join(" "));
    if(/\balex(?:ander)?\b/.test(name))return "office-alex";
    if(/\bjudith\b/.test(name))return "office-judith";
    if(/\bgeri\b|\bgerry\b/.test(name))return "office-geri";
    return "";
  }
  function alexFallbackRow(){
    return {id:"alex-fink-fallback",days:[1,2,3,4,5],from:"07:00",to:"13:48",lunchFrom:"",lunchTo:"",pauseFrom:"",pauseTo:"",activityCode:"022",activityLabel:"Baustelle < 120 km"};
  }
  function pseudoModel(id){
    if(id==="office-alex")return {id,name:"Alex",blocks:{finkFixed:{enabled:true,rows:[alexFallbackRow()]}}};
    if(id==="office-judith")return {id,name:"Judith",blocks:{finkFixed:{enabled:true,rows:[]}}};
    if(id==="office-geri")return {id,name:"Geri",blocks:{finkFixed:{enabled:true,rows:[]}}};
    return null;
  }
  function modelForEmployee(emp,models){
    const direct=models.find(row=>String(row?.id||"")===String(emp?.worktimeModelId||""));
    if(direct)return direct;
    const expected=expectedOfficeModelId(emp);
    return models.find(row=>String(row?.id||"")===expected)||pseudoModel(expected);
  }
  function activeDate(){
    try{return String(state?.activeDate||document.getElementById("dateSelect")?.value||"").slice(0,10)}catch{return String(document.getElementById("dateSelect")?.value||"").slice(0,10)}
  }
  function absenceLabel(){
    try{
      const item=typeof activeQueueItem==="function"?activeQueueItem():null;
      return typeof absenceLabelForItem==="function"?String(absenceLabelForItem(item)||"").trim():"";
    }catch{return ""}
  }
  function fixedRow(model,date){
    const block=model?.blocks?.finkFixed;
    if(!date)return null;
    const day=weekday(date);
    const row=(block?.rows||[]).find(row=>Array.isArray(row?.days)&&row.days.map(Number).includes(day)&&row.from&&row.to)||null;
    if(row)return row;
    if(String(model?.id||"")==="office-alex"&&day>=1&&day<=5)return alexFallbackRow();
    return null;
  }
  function activity(row){
    const code=String(row?.activityCode||"").trim();
    const label=String(row?.activityLabel||"").trim();
    if(label)return label;
    if(code==="022"||code==="SITE_LT120")return "Baustelle < 120 km";
    if(code==="SITE_GE120")return "Baustelle ≥ 120 km";
    return code||"Finkzeit";
  }
  function timeDetail(row){
    const parts=[`${row.from}–${row.to}`];
    if(row.pauseFrom&&row.pauseTo)parts.push(`Pause ${row.pauseFrom}–${row.pauseTo}`);
    if(row.lunchFrom&&row.lunchTo)parts.push(`Mittag ${row.lunchFrom}–${row.lunchTo}`);
    return parts.join(" · ");
  }
  function ensureStyle(){
    if(document.getElementById("kristaModelTimeColumnStyle"))return;
    const style=document.createElement("style");
    style.id="kristaModelTimeColumnStyle";
    style.textContent=`
      .fink-model-card[hidden]{display:none!important}
      .comparison-grid.has-fink-model.phase-times,
      .comparison-grid.has-fink-model.phase-regie,
      .comparison-grid.has-fink-model.phase-release{grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;align-items:start}
      .comparison-grid.has-fink-model.phase-times .gps-card,
      .comparison-grid.has-fink-model.phase-regie .regie-card,
      .comparison-grid.has-fink-model.phase-release .release-card{grid-column:1/-1;min-height:0!important;height:auto!important}
      .comparison-grid.has-fink-model article{min-height:0}
      .fink-model-card{min-height:0!important}
      .fink-model-card header{grid-template-columns:35px 1fr auto!important}
      .fink-model-step{background:#315f7f!important}
      .fink-model-pill{background:#e8f1f7!important;color:#315f7f!important}
      .fink-model-body{padding:14px;display:flex;flex-direction:column;gap:10px}
      .fink-model-main{border:1px solid #d9e4eb;background:#f5f9fb;border-radius:12px;padding:13px}
      .fink-model-main span{display:block;color:#6c7880;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .fink-model-main strong{display:block;font-size:18px;margin-top:3px;color:#244d69}
      .fink-model-time{font-weight:800;margin-top:6px;line-height:1.4}
      .fink-model-note{font-size:11px;line-height:1.45;color:#69736d;background:#f7f7f5;border-radius:10px;padding:9px 10px}
      .fink-model-empty{display:grid;place-items:center;min-height:110px;text-align:center;color:#7d857f;padding:16px}
      .truth-card.actual-productivity header p{font-weight:750;color:#2e6942}
      .comparison-grid.has-fink-model.phase-release .release-card .release-summary{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.2fr);gap:14px;align-items:start}
      .comparison-grid.has-fink-model.phase-release .release-card .release-checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px 12px}
      .comparison-grid.has-fink-model.phase-release .release-card textarea{min-height:58px!important}
      .comparison-grid.has-fink-model.phase-release .release-card .release-actions{margin-top:10px}
      @media(max-width:1000px){
        .comparison-grid.has-fink-model.phase-times,.comparison-grid.has-fink-model.phase-regie,.comparison-grid.has-fink-model.phase-release{grid-template-columns:1fr!important}
        .comparison-grid.has-fink-model.phase-times .gps-card,.comparison-grid.has-fink-model.phase-regie .regie-card,.comparison-grid.has-fink-model.phase-release .release-card{grid-column:auto}
        .comparison-grid.has-fink-model.phase-release .release-card .release-summary{grid-template-columns:1fr}
        .comparison-grid.has-fink-model.phase-release .release-card .release-checks{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }
  function ensureCard(){
    const grid=document.getElementById("comparisonGrid");
    if(!grid)return null;
    let card=document.getElementById("finkModelTimeCard");
    if(!card){
      card=document.createElement("article");
      card.id="finkModelTimeCard";
      card.className="fink-model-card";
      card.hidden=true;
      const truth=grid.querySelector(".truth-card");
      if(truth)truth.insertAdjacentElement("afterend",card);else grid.prepend(card);
    }
    return card;
  }
  function setActualProductivity(isAlex){
    const truth=document.querySelector(".truth-card");
    if(!truth)return;
    truth.classList.toggle("actual-productivity",Boolean(isAlex));
    const p=truth.querySelector("header p");
    if(!p)return;
    if(isAlex){
      if(!p.dataset.kristaOriginal)p.dataset.kristaOriginal=p.textContent||"";
      p.textContent="Tatsächlich produktiv · echte Stempelungen / Projektzeit";
    }else if(p.dataset.kristaOriginal){
      p.textContent=p.dataset.kristaOriginal;
    }
  }
  async function render(force=false){
    if(busy)return;
    const emp=employee();
    const date=activeDate();
    const empId=String(emp?.id||emp?.employeeId||"");
    const expected=expectedOfficeModelId(emp);
    const key=`${empId}|${date}|${String(emp?.worktimeModelId||"")}|${expected}`;
    if(!force&&key===lastKey)return;
    lastKey=key;
    busy=true;
    try{
      ensureStyle();
      const models=await loadModels(false);
      const model=modelForEmployee(emp,models);
      const row=fixedRow(model,date);
      const absence=absenceLabel();
      const relevant=Boolean(expected||model?.blocks?.finkFixed?.enabled===true);
      const grid=document.getElementById("comparisonGrid");
      const card=ensureCard();
      const isAlex=String(model?.id||expected)==="office-alex";
      setActualProductivity(isAlex);

      window.__kristaHasFixedModelTime=Boolean(row&&!absence);
      if(!card||!grid)return;

      if(!relevant){
        card.hidden=true;
        card.innerHTML="";
        grid.classList.remove("has-fink-model");
      }else{
        card.hidden=false;
        grid.classList.add("has-fink-model");
        let body="";
        let total="–";
        if(absence){
          body=`<div class="fink-model-empty"><div><strong>${esc(absence)}</strong><br><small>Abwesenheit hat Vorrang vor der fixen Modellzeit.</small></div></div>`;
        }else if(row){
          total=durationLabel(netMinutes(row));
          body=`<div class="fink-model-body">
            <div class="fink-model-main"><span>Tätigkeit</span><strong>${esc(activity(row))}</strong><div class="fink-model-time">${esc(timeDetail(row))}</div></div>
            <div class="fink-model-note">Automatisch aus Arbeitszeitmodell <strong>${esc(model?.name||"Fixmodell")}</strong>. Diese Zeit ist die Fink-Ausgabe; echte Projektstempel bleiben davon getrennt.</div>
          </div>`;
        }else{
          const hint=model?.blocks?.finkFixed?.enabled===false?"Fixe Ausgabe ist im Modell derzeit ausgeschaltet.":"Für diesen Wochentag ist im Modell keine fixe Zeitzeile hinterlegt.";
          body=`<div class="fink-model-empty"><div><strong>Keine fixe Finkzeit für diesen Wochentag</strong><br><small>${esc(hint)}</small></div></div>`;
          lastKey="";
        }
        card.innerHTML=`<header><span class="step-number fink-model-step">F</span><div><h3>FINKZEIT</h3><p>Fixe Ausgabe aus Arbeitszeitmodell</p></div><span class="pill fink-model-pill">MODELL</span></header>${body}<footer><span>Finkzeit</span><strong>${esc(total)}</strong></footer>`;
      }
      try{if(typeof renderRelease==="function")renderRelease()}catch{}
    }finally{busy=false}
  }

  function start(){
    render(true);
    setInterval(()=>render(false),700);
    document.addEventListener("change",event=>{
      if(event.target?.id==="dateSelect"||event.target?.id==="employeeSelect"){
        lastKey="";
        setTimeout(()=>render(true),0);
      }
    });
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();

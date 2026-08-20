"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;

  let modelCache=null;
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
  async function loadModels(){
    if(modelCache)return modelCache;
    try{
      const response=await fetch(withToken("/kristine/api/worktime-models-v2"),{credentials:"same-origin"});
      const body=await response.json();
      modelCache=response.ok&&body?.ok!==false&&Array.isArray(body?.models)?body.models:[];
    }catch{
      modelCache=[];
    }
    return modelCache;
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
  function modelForEmployee(emp,models){
    const direct=models.find(row=>String(row?.id||"")===String(emp?.worktimeModelId||""));
    if(direct)return direct;
    const name=norm([emp?.nickname,emp?.name,emp?.employeeName].filter(Boolean).join(" "));
    if(/\balex(?:ander)?\b/.test(name))return models.find(row=>String(row?.id||"")==="office-alex")||null;
    if(/\bjudith\b/.test(name))return models.find(row=>String(row?.id||"")==="office-judith")||null;
    if(/\bgeri\b|\bgerry\b/.test(name))return models.find(row=>String(row?.id||"")==="office-geri")||null;
    return null;
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
    if(block?.enabled!==true||!date)return null;
    const day=weekday(date);
    return (block.rows||[]).find(row=>Array.isArray(row?.days)&&row.days.map(Number).includes(day)&&row.from&&row.to)||null;
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
      .comparison-grid.has-fink-model.phase-release{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .comparison-grid.has-fink-model.phase-times .gps-card,
      .comparison-grid.has-fink-model.phase-regie .regie-card,
      .comparison-grid.has-fink-model.phase-release .release-card{grid-column:1/-1;min-height:0!important}
      .comparison-grid.has-fink-model.phase-times .gps-card,
      .comparison-grid.has-fink-model.phase-regie .regie-card{max-height:none}
      .fink-model-card header{grid-template-columns:35px 1fr auto!important}
      .fink-model-step{background:#315f7f!important}
      .fink-model-pill{background:#e8f1f7!important;color:#315f7f!important}
      .fink-model-body{padding:18px;display:flex;flex:1;flex-direction:column;gap:13px}
      .fink-model-main{border:1px solid #d9e4eb;background:#f5f9fb;border-radius:13px;padding:15px}
      .fink-model-main span{display:block;color:#6c7880;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .fink-model-main strong{display:block;font-size:18px;margin-top:4px;color:#244d69}
      .fink-model-time{font-weight:800;margin-top:8px;line-height:1.5}
      .fink-model-note{font-size:12px;line-height:1.5;color:#69736d;background:#f7f7f5;border-radius:11px;padding:11px 12px}
      .fink-model-empty{display:grid;place-items:center;min-height:180px;text-align:center;color:#7d857f;padding:20px}
      .truth-card.actual-productivity header p{font-weight:750;color:#2e6942}
      @media(max-width:1000px){
        .comparison-grid.has-fink-model.phase-times,.comparison-grid.has-fink-model.phase-regie,.comparison-grid.has-fink-model.phase-release{grid-template-columns:1fr}
        .comparison-grid.has-fink-model.phase-times .gps-card,.comparison-grid.has-fink-model.phase-regie .regie-card,.comparison-grid.has-fink-model.phase-release .release-card{grid-column:auto}
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
    const key=`${empId}|${date}|${String(emp?.worktimeModelId||"")}`;
    if(!force&&key===lastKey)return;
    lastKey=key;
    busy=true;
    try{
      ensureStyle();
      const models=await loadModels();
      const model=modelForEmployee(emp,models);
      const block=model?.blocks?.finkFixed;
      const row=fixedRow(model,date);
      const absence=absenceLabel();
      const relevant=Boolean(block?.enabled===true);
      const grid=document.getElementById("comparisonGrid");
      const card=ensureCard();
      const isAlex=String(model?.id||"")==="office-alex";
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
            <div class="fink-model-note">Automatisch aus Arbeitszeitmodell <strong>${esc(model?.name||"")}</strong>. Diese Zeit ist die Fink-Ausgabe; echte Projektstempel bleiben davon getrennt.</div>
          </div>`;
        }else{
          body=`<div class="fink-model-empty"><div><strong>Keine fixe Finkzeit für diesen Wochentag</strong><br><small>Im Arbeitszeitmodell ${esc(model?.name||"")} ist für ${esc(date)} keine Zeitzeile hinterlegt.</small></div></div>`;
        }
        card.innerHTML=`<header><span class="step-number fink-model-step">F</span><div><h3>FINKZEIT</h3><p>Fixe Ausgabe aus Arbeitszeitmodell</p></div><span class="pill fink-model-pill">MODELL</span></header>${body}<footer><span>Finkzeit</span><strong>${esc(total)}</strong></footer>`;
      }
      try{if(typeof renderRelease==="function")renderRelease()}catch{}
    }finally{busy=false}
  }

  function start(){
    render(true);
    setInterval(()=>render(false),350);
    document.addEventListener("change",event=>{
      if(event.target?.id==="dateSelect"||event.target?.id==="employeeSelect"){
        lastKey="";
        setTimeout(()=>render(true),0);
      }
    });
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();

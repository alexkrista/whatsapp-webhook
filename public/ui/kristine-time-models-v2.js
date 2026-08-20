"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("/kristine"))return;

  const DAY_LABELS=[[1,"Mo"],[2,"Di"],[3,"Mi"],[4,"Do"],[5,"Fr"],[6,"Sa"],[7,"So"]];
  const BLOCKS=[
    ["planning","1 · Planungsstunden","Modellstunden für Planung und produktive Mitarbeiter"],
    ["finkTarget","2 · Sollstunden Finkzeit","Soll / Std. Finkzeit für alle"],
    ["finkFixed","3 · Finkzeit-Ausgabe fix","Optionale fixe Ausgabe – z. B. Judith, Alex, Geri"]
  ];
  const ACTIVITIES=[
    ["","Tätigkeit wählen"],
    ["022","022 · Büro"],
    ["SITE_LT120","Baustelle < 120 km"],
    ["SITE_GE120","Baustelle ≥ 120 km"],
    ["913","913 · Werkstatt"],
    ["917","917 · Firma aufräumen"],
    ["909","909 · Schulung intern"],
    ["900","900 · Urlaub"],
    ["901","901 · Krank"],
    ["902","902 · Arzt"],
    ["904","904 · Feiertag"],
    ["930","930 · Zeitausgleich"]
  ];

  let models=[];
  let loading=false;
  let installed=false;

  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function withToken(pathname){const u=new URL(pathname,location.origin),t=new URLSearchParams(location.search).get("token");if(t)u.searchParams.set("token",t);return `${u.pathname}${u.search}`}
  function mins(hm){const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/);return m?Number(m[1])*60+Number(m[2]):null}
  function overlap(a1,a2,b1,b2){const aa=mins(a1),ab=mins(a2),ba=mins(b1),bb=mins(b2);if([aa,ab,ba,bb].some(v=>v===null))return 0;return Math.max(0,Math.min(ab,bb)-Math.max(aa,ba))}
  function netHours(row){const a=mins(row.from),b=mins(row.to);if(a===null||b===null||b<=a)return 0;return Math.max(0,(b-a-overlap(row.from,row.to,row.pauseFrom,row.pauseTo)-overlap(row.from,row.to,row.lunchFrom,row.lunchTo))/60)}
  function hours(v){return Number(v||0).toLocaleString("de-AT",{minimumFractionDigits:2,maximumFractionDigits:2})+" h"}
  function uid(){return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`}
  function emptyBlocks(){return {planning:{label:"Planungsstunden",rows:[]},finkTarget:{label:"Sollstunden Finkzeit",rows:[]},finkFixed:{label:"Finkzeit-Ausgabe fix",enabled:false,rows:[]}}}
  function modelById(id){return models.find(m=>String(m.id)===String(id))||null}
  function rowBy(modelId,blockKey,rowId){return modelById(modelId)?.blocks?.[blockKey]?.rows?.find(r=>String(r.id)===String(rowId))||null}

  function injectStyle(){
    if(document.getElementById("kristaTimeModelsV2Style"))return;
    const s=document.createElement("style");s.id="kristaTimeModelsV2Style";s.textContent=`
      #scheduleModelList{display:grid;gap:16px;min-width:0}
      .tm2-card{background:#fff;border:1px solid #dedbd4;border-left:5px solid #27713d;border-radius:16px;padding:16px;box-shadow:0 2px 12px rgba(0,0,0,.04);min-width:0;overflow:hidden}
      .tm2-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.tm2-name{font-size:20px;font-weight:900}.tm2-head-actions{display:flex;gap:7px;flex-wrap:wrap}.tm2-head-actions button{padding:7px 10px}
      .tm2-block{border:1px solid #e7e3dc;border-radius:14px;overflow:hidden;margin-top:11px;min-width:0}.tm2-block-head{display:flex;justify-content:space-between;gap:12px;align-items:center;background:#f7f5f0;padding:11px 13px}.tm2-block-head strong{font-size:15px}.tm2-block-head small{display:block;color:#707070;margin-top:2px}.tm2-fixed-toggle{display:flex!important;align-items:center;gap:7px;margin:0!important;font-weight:800;color:#333;white-space:nowrap}.tm2-fixed-toggle input{width:auto!important}
      .tm2-rows{padding:5px 12px 10px;min-width:0}
      .tm2-row{display:grid;grid-template-columns:minmax(230px,1.28fr) repeat(6,minmax(78px,.68fr)) minmax(76px,.5fr) 30px;gap:7px;align-items:end;padding:10px 0;border-top:1px solid #eee;min-width:0}
      .tm2-row:first-child{border-top:0}
      .tm2-row.has-activity{grid-template-columns:minmax(230px,1.15fr) repeat(6,minmax(72px,.58fr)) minmax(135px,.92fr) minmax(72px,.45fr) 30px}
      .tm2-days{display:flex;gap:3px;flex-wrap:nowrap;align-items:center;align-self:end;padding-bottom:1px;white-space:nowrap;min-width:0}
      .tm2-day{width:30px!important;min-width:30px!important;height:30px;padding:0!important;border-radius:50%!important;background:#fff!important;color:#444!important;border:1px solid #cfd3cf!important;font-size:12px!important;font-weight:800;line-height:1!important;flex:0 0 30px}
      .tm2-day.on{background:#27713d!important;color:#fff!important;border-color:#27713d!important}
      .tm2-field{min-width:0}.tm2-field label{font-size:9px;text-transform:uppercase;letter-spacing:.035em;color:#777;white-space:nowrap}.tm2-field input,.tm2-field select{box-sizing:border-box;padding:7px 6px!important;min-width:0!important;width:100%!important;max-width:100%!important;font-size:12px!important}
      .tm2-field input[type="time"]{appearance:auto}
      .tm2-net{background:#eef7ee;border-radius:9px;padding:7px 5px;text-align:center;font-size:12px;font-weight:900;white-space:nowrap;min-width:0}.tm2-remove{width:30px!important;min-width:30px!important;height:30px;padding:0!important;background:#fff!important;color:#9d2525!important;border:1px solid #e0bcbc!important;align-self:end}.tm2-empty{padding:13px;color:#777;font-size:13px}.tm2-add{margin:0 12px 12px;padding:7px 10px!important;background:#fff!important;color:#202020!important;border:1px solid #ccc!important}.tm2-savebar{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}.tm2-savebar .green{font-weight:800}.tm2-note{margin-right:auto;color:#27713d;font-weight:800;font-size:12px;align-self:center}
      @media(max-width:1050px){.tm2-row,.tm2-row.has-activity{grid-template-columns:repeat(4,minmax(120px,1fr))}.tm2-days{grid-column:1/-1;justify-content:flex-start}.tm2-net{align-self:end}.tm2-remove{align-self:end}.tm2-row.has-activity .tm2-activity{grid-column:1/3}}
      @media(max-width:700px){.tm2-row,.tm2-row.has-activity{grid-template-columns:1fr 1fr}.tm2-days{grid-column:1/-1}.tm2-row.has-activity .tm2-activity{grid-column:1/-1}.tm2-head{align-items:flex-start;flex-direction:column}.tm2-block-head{align-items:flex-start;flex-direction:column}}
    `;document.head.appendChild(s);
  }

  function activityOptions(row){
    const known=ACTIVITIES.some(([code])=>code===String(row.activityCode||""));
    const custom=!known&&row.activityLabel?`<option value="${esc(row.activityCode||"CUSTOM")}" data-label="${esc(row.activityLabel)}" selected>${esc(row.activityLabel)}</option>`:"";
    return custom+ACTIVITIES.map(([code,label])=>`<option value="${esc(code)}" data-label="${esc(label.replace(/^\d{3} · /,""))}" ${String(row.activityCode||"")===code?"selected":""}>${esc(label)}</option>`).join("");
  }
  function rowHtml(model,blockKey,row){
    const fixed=blockKey==="finkFixed";
    return `<div class="tm2-row ${fixed?"has-activity":""}" data-model="${esc(model.id)}" data-block="${blockKey}" data-row="${esc(row.id)}">
      <div class="tm2-days">${DAY_LABELS.map(([d,l])=>`<button type="button" class="tm2-day ${(row.days||[]).includes(d)?"on":""}" data-day="${d}">${l}</button>`).join("")}</div>
      <div class="tm2-field"><label>Von</label><input type="time" data-field="from" value="${esc(row.from||"")}"></div>
      <div class="tm2-field"><label>Bis</label><input type="time" data-field="to" value="${esc(row.to||"")}"></div>
      <div class="tm2-field"><label>Mittag von</label><input type="time" data-field="lunchFrom" value="${esc(row.lunchFrom||"")}"></div>
      <div class="tm2-field"><label>Mittag bis</label><input type="time" data-field="lunchTo" value="${esc(row.lunchTo||"")}"></div>
      <div class="tm2-field"><label>Pause von</label><input type="time" data-field="pauseFrom" value="${esc(row.pauseFrom||"")}"></div>
      <div class="tm2-field"><label>Pause bis</label><input type="time" data-field="pauseTo" value="${esc(row.pauseTo||"")}"></div>
      ${fixed?`<div class="tm2-field tm2-activity"><label>Tätigkeit</label><select data-field="activity">${activityOptions(row)}</select></div>`:""}
      <div class="tm2-net" title="Netto nach den eingetragenen Pausen">${hours(netHours(row))}</div>
      <button type="button" class="tm2-remove" title="Zeile löschen">×</button>
    </div>`;
  }
  function blockHtml(model,key,title,subtitle){
    const block=model.blocks?.[key]||{rows:[]};
    const fixed=key==="finkFixed";
    const rows=block.rows||[];
    return `<section class="tm2-block" data-block-card="${key}">
      <div class="tm2-block-head"><div><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></div>${fixed?`<label class="tm2-fixed-toggle"><input type="checkbox" data-fixed-enabled="1" ${block.enabled?"checked":""}> fixe Ausgabe verwenden</label>`:""}</div>
      <div class="tm2-rows">${rows.length?rows.map(r=>rowHtml(model,key,r)).join(""):`<div class="tm2-empty">Noch keine Zeitzeile. Mit „+ neue Zeile“ Wochentage und Zeiten festlegen.</div>`}</div>
      <button type="button" class="tm2-add" data-add-row="${key}">+ neue Zeile</button>
    </section>`;
  }
  function modelHtml(model){
    model.blocks=model.blocks||emptyBlocks();
    return `<article class="tm2-card" data-model-card="${esc(model.id)}">
      <div class="tm2-head"><div><div class="tm2-name">${esc(model.name||"Arbeitsmodell")}</div><small>${model.id==="krista-standard"?"Produktionsmodell – bei Saisonwechsel einfach die Zeitzeilen ändern.":"Zuordnung erfolgt in der Mitarbeiterkarte."}</small></div><div class="tm2-head-actions"><button type="button" class="secondary" data-rename-model="1">Umbenennen</button>${model.systemProtected?"":`<button type="button" class="danger" data-remove-model="1">Löschen</button>`}</div></div>
      ${BLOCKS.map(([key,title,subtitle])=>blockHtml(model,key,title,subtitle)).join("")}
      <div class="tm2-savebar"><span class="tm2-note"></span><button type="button" class="green" data-save-models="1">💾 Modelle speichern</button></div>
    </article>`;
  }

  function render(){
    injectStyle();
    const el=document.getElementById("scheduleModelList");if(!el)return;
    const summary=document.getElementById("modelSummary");if(summary)summary.textContent=`${models.length} Arbeitsmodelle · zentrale Logik`;
    el.innerHTML=models.length?models.map(modelHtml).join(""):'<div class="tm2-empty">Keine Arbeitsmodelle vorhanden.</div>';
  }

  function applyGlobals(){
    try{worktimeModels=models}catch{}
    try{data.scheduleModels=models}catch{}
  }
  async function load(){
    if(loading)return;loading=true;
    const el=document.getElementById("scheduleModelList");if(el)el.innerHTML='<div class="tm2-empty">Arbeitsmodelle werden geladen …</div>';
    try{
      const response=await fetch(withToken("/kristine/api/worktime-models-v2"),{credentials:"same-origin"});
      const body=await response.json();if(!response.ok||body.ok===false)throw new Error(body.error||`HTTP ${response.status}`);
      models=Array.isArray(body.models)?body.models:[];applyGlobals();render();
    }catch(error){if(el)el.innerHTML=`<div class="tm2-empty">Zeitmodelle konnten nicht geladen werden: ${esc(error.message)}</div>`}
    finally{loading=false}
  }
  async function save(){
    document.querySelectorAll("[data-save-models]").forEach(b=>{b.disabled=true;b.textContent="Speichert …"});
    try{
      const response=await fetch(withToken("/kristine/api/worktime-models-v2"),{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({models})});
      const body=await response.json();if(!response.ok||body.ok===false)throw new Error(body.error||`HTTP ${response.status}`);
      models=Array.isArray(body.models)?body.models:models;applyGlobals();render();
      document.querySelectorAll(".tm2-note").forEach(n=>n.textContent="✓ gespeichert");
      const old=document.getElementById("modelSavedNote");if(old)old.textContent="✓ zentral gespeichert";
    }catch(error){alert(`Arbeitsmodelle: ${error.message}`);render()}
  }
  function addModel(){models.push({id:`model-${Date.now().toString(36)}`,name:"Neues Arbeitsmodell",active:true,systemProtected:false,timeModelVersion:2,blocks:emptyBlocks()});render()}

  function bind(){
    const list=document.getElementById("scheduleModelList");if(!list||list.dataset.tm2Bound)return;list.dataset.tm2Bound="1";
    list.addEventListener("click",event=>{
      const card=event.target.closest("[data-model-card]");if(!card)return;const model=modelById(card.dataset.modelCard);if(!model)return;
      const rowEl=event.target.closest(".tm2-row");
      if(event.target.matches(".tm2-day")&&rowEl){const r=rowBy(model.id,rowEl.dataset.block,rowEl.dataset.row),d=Number(event.target.dataset.day);if(!r)return;r.days=r.days||[];r.days=r.days.includes(d)?r.days.filter(x=>x!==d):[...r.days,d].sort((a,b)=>a-b);render();return}
      if(event.target.matches(".tm2-remove")&&rowEl){const block=model.blocks?.[rowEl.dataset.block];if(block)block.rows=(block.rows||[]).filter(r=>String(r.id)!==String(rowEl.dataset.row));render();return}
      const add=event.target.closest("[data-add-row]");if(add){const key=add.dataset.addRow;model.blocks=model.blocks||emptyBlocks();model.blocks[key]=model.blocks[key]||{rows:[]};model.blocks[key].rows=model.blocks[key].rows||[];model.blocks[key].rows.push({id:uid(),days:[],from:"",to:"",lunchFrom:"",lunchTo:"",pauseFrom:"",pauseTo:"",activityCode:"",activityLabel:""});if(key==="finkFixed")model.blocks[key].enabled=true;render();return}
      if(event.target.closest("[data-rename-model]")){const name=prompt("Modellname:",model.name||"");if(name&&name.trim()){model.name=name.trim();render()}return}
      if(event.target.closest("[data-remove-model]")){if(confirm(`Arbeitsmodell „${model.name}“ wirklich löschen?`)){models=models.filter(m=>m!==model);render()}return}
      if(event.target.closest("[data-save-models]")){save();return}
    });
    list.addEventListener("change",event=>{
      const card=event.target.closest("[data-model-card]");if(!card)return;const model=modelById(card.dataset.modelCard);if(!model)return;
      if(event.target.matches("[data-fixed-enabled]")){model.blocks.finkFixed.enabled=event.target.checked;return}
      const rowEl=event.target.closest(".tm2-row");if(!rowEl)return;const r=rowBy(model.id,rowEl.dataset.block,rowEl.dataset.row);if(!r)return;
      const field=event.target.dataset.field;if(!field)return;
      if(field==="activity"){r.activityCode=event.target.value;r.activityLabel=event.target.selectedOptions[0]?.dataset.label||event.target.selectedOptions[0]?.textContent||""}else r[field]=event.target.value;
      const net=rowEl.querySelector(".tm2-net");if(net)net.textContent=hours(netHours(r));
    });
  }

  function install(){
    const list=document.getElementById("scheduleModelList");if(!list)return false;
    injectStyle();bind();
    window.renderScheduleModels=render;
    window.addScheduleModel=addModel;
    window.editScheduleModelName=function(id){const m=modelById(id);if(!m)return;const n=prompt("Modellname:",m.name||"");if(n&&n.trim()){m.name=n.trim();render()}};
    window.removeScheduleModel=function(id){const m=modelById(id);if(m&&!m.systemProtected&&confirm(`Arbeitsmodell „${m.name}“ wirklich löschen?`)){models=models.filter(x=>x!==m);render()}};
    window.saveScheduleModelsData=save;
    if(!installed){installed=true;load()}else render();
    return true;
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{if(!install()){let n=0;const t=setInterval(()=>{if(install()||++n>20)clearInterval(t)},150)}});else if(!install()){let n=0;const t=setInterval(()=>{if(install()||++n>20)clearInterval(t)},150)}
})();

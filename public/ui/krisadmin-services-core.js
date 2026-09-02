"use strict";

(function(){
  const VERSION="2026-08-26-services-4";
  const MANAGER="http://127.0.0.1:8765";
  let timer=null;
  let lampTimer=null;
  let lampObserver=null;
  let lampLevel="red";

  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const token=()=>new URLSearchParams(location.search).get("token")||"";

  function installCss(){
    if(document.getElementById("kristaServicesCss"))return;
    const style=document.createElement("style");
    style.id="kristaServicesCss";
    style.textContent=`
      .ksvc-open{background:#20372a!important;border-color:#20372a!important;color:#fff!important;font-weight:850!important}
      .ksvc-top-lamp{min-height:34px!important;height:34px!important;margin:0!important;padding:6px 8px!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:9px!important;background:rgba(255,255,255,.07)!important;color:#fff!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:5px!important;font:800 10.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif!important;cursor:pointer!important;white-space:nowrap!important;box-sizing:border-box!important}
      .ksvc-top-lamp:hover{background:rgba(255,255,255,.14)!important}.ksvc-top-lamp .ksvc-lamp-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto;background:#c64646}.ksvc-top-lamp.green .ksvc-lamp-dot{background:#55c77a}.ksvc-top-lamp.red .ksvc-lamp-dot{background:#ef6860}
      .ksvc-bg{position:fixed;inset:0;z-index:70050;background:rgba(6,10,8,.58);display:none;place-items:center;padding:18px;backdrop-filter:blur(2px)}.ksvc-bg.open{display:grid}
      .ksvc-modal{width:min(1180px,100%);max-height:92vh;overflow:auto;background:#f5f4ef;border-radius:20px;box-shadow:0 28px 100px rgba(0,0,0,.32);border:1px solid #d7d5ce}
      .ksvc-head{position:sticky;top:0;z-index:2;background:#17211b;color:#fff;padding:17px 20px;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.ksvc-head h2{margin:0;font-size:21px}.ksvc-head small{display:block;color:#c7d0ca;margin-top:4px}.ksvc-head-actions{display:flex;gap:8px;align-items:center}.ksvc-head button{min-width:auto}
      .ksvc-body{padding:18px}.ksvc-summary{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.ksvc-chip{display:inline-flex;gap:6px;align-items:center;border-radius:999px;background:#fff;border:1px solid #ddd9cf;padding:6px 9px;font-size:11px;font-weight:800;color:#4b514c}
      .ksvc-table{display:grid;gap:9px}.ksvc-row{display:grid;grid-template-columns:minmax(190px,1.35fr) minmax(130px,.8fr) minmax(150px,.9fr) minmax(150px,.9fr) minmax(100px,.65fr) minmax(140px,.85fr);gap:10px;align-items:center;background:#fff;border:1px solid #dedbd3;border-radius:14px;padding:12px 13px;box-shadow:0 4px 15px rgba(23,33,27,.035)}
      .ksvc-service{display:flex;gap:10px;align-items:flex-start;min-width:0}.ksvc-icon{font-size:22px;line-height:1}.ksvc-service strong{display:block}.ksvc-detail{font-size:11px;color:#747a74;margin-top:3px;overflow-wrap:anywhere}.ksvc-label{display:none;font-size:9px;color:#8a8e8a;font-weight:850;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
      .ksvc-status{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:900;border-radius:999px;padding:6px 9px;width:max-content;max-width:100%}.ksvc-status::before{content:"";width:8px;height:8px;border-radius:50%;background:#777;flex:none}.ksvc-green{background:#e5f3e9;color:#24603a}.ksvc-green::before{background:#36a05d}.ksvc-yellow{background:#fff0cf;color:#7d561b}.ksvc-yellow::before{background:#d79229}.ksvc-red{background:#f8dddd;color:#8a2929}.ksvc-red::before{background:#c64646}
      .ksvc-value{font-size:12px;color:#343934;min-width:0;overflow-wrap:anywhere}.ksvc-value strong{font-size:13px}.ksvc-commit{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.ksvc-commit.pending{color:#9a5b00;font-weight:900}.ksvc-action button{width:100%;min-height:36px;padding:7px 9px;font-size:11px;font-weight:850}.ksvc-action .start{background:#24733b;border-color:#24733b}.ksvc-action .restart{background:#315d91;border-color:#315d91}.ksvc-error{font-size:10px;color:#9b1c1c;margin-top:4px}.ksvc-empty{padding:22px;background:#fff;border:1px solid #ddd9cf;border-radius:14px;color:#5d635e;line-height:1.5}.ksvc-empty strong{color:#272c28}.ksvc-msg{margin-top:12px;font-size:12px;font-weight:750}.ksvc-msg.ok{color:#24603a}.ksvc-msg.error{color:#9b1c1c}
      @media(max-width:900px){.ksvc-row{grid-template-columns:1fr 1fr}.ksvc-service{grid-column:1/-1}.ksvc-label{display:block}.ksvc-action{grid-column:1/-1}.ksvc-action button{width:auto}}
      @media(max-width:560px){.ksvc-bg{padding:0}.ksvc-modal{width:100%;height:100%;max-height:none;border-radius:0}.ksvc-row{grid-template-columns:1fr}.ksvc-head{padding:14px}.ksvc-body{padding:12px}.ksvc-head-actions button:first-child{display:none}.ksvc-action{grid-column:auto}.ksvc-action button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function mountButton(){
    if(document.getElementById("kristaServicesButton"))return;
    const path=location.pathname.toLowerCase();
    let host=null;
    if(path.includes("baustellen.html"))host=document.querySelector(".head-actions");
    if(!host&&path.includes("/admin"))host=document.querySelector(".bar.krista-module-nav");
    if(!host)return;
    const button=document.createElement("button");
    button.id="kristaServicesButton";button.type="button";button.className="ksvc-open";button.textContent="🩺 Dienste";
    button.onclick=open;
    host.appendChild(button);
  }

  function applyLamp(){
    const button=document.querySelector("#kristaAccessSlot [data-services]");
    if(!button)return;
    const dot=button.querySelector(".krista-dot");if(dot)dot.className="krista-dot "+(lampLevel==="green"?"green":"red");
    button.title=lampLevel==="green"?"Dienste okay · klicken für Details":"Dienstefehler · klicken für Details";
  }

  function mountTopLamp(){
    const button=document.querySelector("#kristaAccessSlot [data-services]");
    if(button)button.onclick=open;
    return button;
  }

  async function refreshLamp(){
    mountTopLamp();
    try{
      const data=await managerFetch("/api/status");
      const rows=Array.isArray(data.rows)?data.rows:[];
      lampLevel=rows.some(row=>row?.level==="red")?"red":"green";
    }catch(_){
      lampLevel="red";
    }
    applyLamp();
  }

  function startLamp(){
    mountTopLamp();
  }

  function ensureModal(){
    let bg=document.getElementById("kristaServicesBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaServicesBg";bg.className="ksvc-bg";
    bg.innerHTML=`<section class="ksvc-modal" role="dialog" aria-modal="true" aria-labelledby="kristaServicesTitle"><div class="ksvc-head"><div><h2 id="kristaServicesTitle">🩺 KRISTA Dienste</h2><small>Was läuft · welche Version · welcher Git-Stand · Neustart direkt von hier</small></div><div class="ksvc-head-actions"><button type="button" class="secondary" id="kristaServicesRefresh">↻ Aktualisieren</button><button type="button" class="secondary" data-close>✕</button></div></div><div class="ksvc-body"><div id="kristaServicesContent" class="ksvc-empty">Dienste werden geprüft …</div><div id="kristaServicesMsg" class="ksvc-msg"></div></div></section>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if(e.target===bg||e.target.closest("[data-close]"))close()});
    bg.querySelector("#kristaServicesRefresh").onclick=load;
    return bg;
  }

  async function managerFetch(path,options={}){
    const headers={...(options.headers||{})};
    const t=token();if(t)headers["X-Krista-Admin-Token"]=t;
    const response=await fetch(MANAGER+path,{...options,headers,cache:"no-store"});
    const text=await response.text();let data=null;try{data=JSON.parse(text||"{}") }catch{}
    if(!response.ok||!data?.ok)throw new Error(data?.error||text||`HTTP ${response.status}`);
    return data;
  }

  function uptime(seconds){
    let s=Math.max(0,Number(seconds||0));if(!s)return "–";
    const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);
    if(d)return `${d}d ${h}h`;if(h)return `${h}h ${m}m`;return `${m}m`;
  }

  function commitCell(row){
    const running=String(row.runningCommit||"");const current=String(row.currentCommit||"");
    if(!running&&!current)return "–";
    const pending=running&&current&&running!==current;
    if(pending)return `<div class="ksvc-commit pending">läuft ${esc(running)}<br>aktuell ${esc(current)}</div>`;
    return `<div class="ksvc-commit">${esc(running||current)}</div>`;
  }

  function actionCell(row){
    if(row.canStart)return `<button type="button" class="start" data-service="${esc(row.id)}" data-action="start">▶ Starten</button>`;
    if(row.canRestart)return `<button type="button" class="restart" data-service="${esc(row.id)}" data-action="restart">↻ Neu starten</button>`;
    return `<span class="ksvc-detail">nur Status</span>`;
  }

  function render(data){
    const content=document.getElementById("kristaServicesContent");if(!content)return;
    const rows=Array.isArray(data.rows)?data.rows:[];
    const green=rows.filter(x=>x.level==="green").length,yellow=rows.filter(x=>x.level==="yellow").length,red=rows.filter(x=>x.level==="red").length;
    lampLevel=red>0?"red":"green";applyLamp();
    content.className="";
    content.innerHTML=`<div class="ksvc-summary"><span class="ksvc-chip">🟢 ${green} okay</span><span class="ksvc-chip">🟡 ${yellow} beachten</span><span class="ksvc-chip">🔴 ${red} Fehler</span><span class="ksvc-chip">Git ${esc(data.repo?.branch||'–')} · ${esc(data.repo?.shortCommit||'–')}${data.repo?.dirty?' · lokale Änderungen':''}</span></div><div class="ksvc-table">${rows.map(row=>`<div class="ksvc-row"><div class="ksvc-service"><span class="ksvc-icon">${esc(row.icon||'•')}</span><div><strong>${esc(row.name||row.id)}</strong><div class="ksvc-detail">${esc(row.detail||'')}</div>${row.lastError?`<div class="ksvc-error">⚠ ${esc(row.lastError)}</div>`:''}</div></div><div><span class="ksvc-label">Status</span><span class="ksvc-status ksvc-${esc(row.level||'red')}">${esc(row.status||'–')}</span></div><div class="ksvc-value"><span class="ksvc-label">Version</span><strong>${esc(row.version||'–')}</strong></div><div class="ksvc-value"><span class="ksvc-label">Git / aktuell</span>${commitCell(row)}</div><div class="ksvc-value"><span class="ksvc-label">Laufzeit</span>${esc(uptime(row.uptimeSeconds))}</div><div class="ksvc-action"><span class="ksvc-label">Aktion</span>${actionCell(row)}</div></div>`).join("")}</div>`;
    content.querySelectorAll("[data-service][data-action]").forEach(button=>button.onclick=()=>runAction(button.dataset.service,button.dataset.action,button));
  }

  function renderOffline(error){
    const content=document.getElementById("kristaServicesContent");if(!content)return;
    content.className="ksvc-empty";
    content.innerHTML=`<strong>🔴 Lokaler KRISTA Dienstemanager ist nicht erreichbar.</strong><br><br>Am Firmen-PC im Projektordner einmal <strong>KRISTA_START.cmd</strong> doppelklicken. Danach hier auf „Aktualisieren“.<br><br><span class="ksvc-detail">${esc(error?.message||error||'')}</span>`;
  }

  async function load(){
    const content=document.getElementById("kristaServicesContent");const msg=document.getElementById("kristaServicesMsg");
    if(content){content.className="ksvc-empty";content.textContent="Dienste werden geprüft …"}if(msg){msg.textContent="";msg.className="ksvc-msg"}
    try{const data=await managerFetch("/api/status");render(data)}catch(error){renderOffline(error)}
  }

  async function runAction(service,action,button){
    const label=service==="brain"?(action==="start"?"Brain Connector starten":"Brain Connector neu starten"):(service==="manager"?"Dienstemanager neu starten":"Dienst neu starten");
    if(!confirm(`${label}?\n\nBitte nur ausführen, wenn gerade niemand eine Rechnung speichert oder einen laufenden Vorgang abschließt.`))return;
    const msg=document.getElementById("kristaServicesMsg");button.disabled=true;
    if(msg){msg.textContent=label+" …";msg.className="ksvc-msg"}
    try{
      const data=await managerFetch("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({service,action})});
      if(msg){msg.textContent="✓ "+(data.message||"Aktion gestartet");msg.className="ksvc-msg ok"}
      let tries=0;clearInterval(timer);timer=setInterval(async()=>{tries++;try{const status=await managerFetch("/api/status");render(status);if(tries>=3&&status.rows?.find(x=>x.id===service)?.level==="green"){clearInterval(timer);timer=null}}catch(_){}if(tries>20){clearInterval(timer);timer=null}},1000);
    }catch(error){if(msg){msg.textContent=error.message||String(error);msg.className="ksvc-msg error"}}
    finally{button.disabled=false}
  }

  function open(){
    installCss();const bg=ensureModal();bg.classList.add("open");load();
    clearInterval(timer);timer=setInterval(()=>{if(bg.classList.contains("open"))load()},15000);
  }
  function close(){const bg=document.getElementById("kristaServicesBg");bg?.classList.remove("open");clearInterval(timer);timer=null}

  window.openKrisadminServices=open;
  window.KrisadminServices={open,close,load,version:VERSION};
  installCss();
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{mountButton();startLamp()},{once:true});else{mountButton();startLamp()}
})();

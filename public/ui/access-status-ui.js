"use strict";
(function(){
  if(window.__kristaAccessStatusV3)return;window.__kristaAccessStatusV3=true;
  const token=new URLSearchParams(location.search).get("token")||"",BRAIN="https://pc-alex02.tail610122.ts.net",isKristine=location.pathname.toLowerCase().includes("/kristine");
  let last=null;
  function css(){if(document.getElementById("kristaAccessV3Css"))return;const s=document.createElement("style");s.id="kristaAccessV3Css";s.textContent=`
  .krista-shell-main.krista-access-v3{grid-template-columns:230px minmax(390px,1fr) auto 150px}
  .krista-access-slot{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
  .krista-door-lamp,.krista-system-lamp{border:1px solid rgba(255,255,255,.18)!important;background:rgba(255,255,255,.07)!important;color:#fff!important;border-radius:10px!important;min-height:38px!important;padding:7px 9px!important;display:inline-flex!important;align-items:center!important;gap:6px!important;font:800 11.5px/1 system-ui!important;cursor:pointer;white-space:nowrap}
  .krista-door-lamp:hover,.krista-system-lamp:hover{background:rgba(255,255,255,.14)!important}.krista-dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:#e7b34d}.krista-dot.green{background:#55c77a}.krista-dot.red{background:#ef6860}.krista-dot.yellow{background:#e7b34d}.krista-door-lamp.pending{opacity:.65;pointer-events:none}
  @media(max-width:1180px){.krista-shell-main.krista-access-v3{grid-template-columns:200px minmax(0,1fr) auto}.krista-access-slot{grid-column:3}.krista-user{display:none}}
  @media(max-width:760px){.krista-shell-main.krista-access-v3{grid-template-columns:minmax(0,1fr) auto!important}.krista-access-slot{grid-column:1/-1;justify-content:flex-start;overflow-x:auto;padding:2px 0}.krista-door-lamp,.krista-system-lamp{flex:0 0 auto}}`;document.head.appendChild(s)}
  function removeOldEntrance(){document.querySelectorAll(".krista-shell-main > a,.krista-shell-main > button").forEach(el=>{if(String(el.textContent||"").trim().toUpperCase()==="EINGANG"&&!el.classList.contains("krista-door-lamp"))el.remove()})}
  function mount(){const main=document.querySelector(".krista-shell-main");if(!main)return null;removeOldEntrance();let slot=document.getElementById("kristaAccessSlot");if(!slot){slot=document.createElement("div");slot.id="kristaAccessSlot";slot.className="krista-access-slot";main.insertBefore(slot,main.querySelector(".krista-user")||null);main.classList.add("krista-access-v3")}return slot}
  function overall(d){if(!d?.online)return"red";const vals=Object.values(d.services||{});if(vals.some(x=>x?.state==="bad"))return"red";if(vals.some(x=>x?.state==="warn"))return"yellow";return"green"}
  function draw(d){last=d;const slot=mount();if(!slot)return;let h=`<button class="krista-system-lamp" data-system><span class="krista-dot ${overall(d)}"></span><span>SYSTEM</span></button>`;
    if(isKristine){const doors=d?.gantner?.doors||{},labels={1:"Eingang",2:"Lager",3:"Büro"};for(const n of[1,2,3]){const x=doors[String(n)]||{},c=!d?.online?"yellow":x.mode==="OPEN"?"green":x.mode==="NORMAL"?"red":"yellow";h+=`<button class="krista-door-lamp" data-door="${n}" title="${String(x.reason||"").replace(/"/g,"&quot;")}"><span class="krista-dot ${c}"></span><span>${labels[n]}</span></button>`}}
    slot.innerHTML=h;slot.querySelector("[data-system]")?.addEventListener("click",()=>location.href="/admin/systemstatus?token="+encodeURIComponent(token));slot.querySelectorAll("[data-door]").forEach(b=>b.addEventListener("click",()=>toggle(b)))}
  async function toggle(btn){if(!token){alert("Admin-Token fehlt.");return}btn.classList.add("pending");const dot=btn.querySelector(".krista-dot");if(dot)dot.className="krista-dot yellow";const door=Number(btn.dataset.door);
    try{const r=await fetch(`${BRAIN}/access-control/toggle/${door}`,{method:"POST",headers:{"X-Krista-Token":token},mode:"cors",cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const d=await r.json();if(!d.ok)throw new Error(d.error||"Schalten fehlgeschlagen");if(last&&d.status?.doors){last={...last,gantner:{...(last.gantner||{}),...d.status}};draw(last)}setTimeout(load,9000)}
    catch(e){alert("Türsteuerung nicht erreichbar. Tailscale auf diesem Gerät prüfen.");load()}}
  async function load(){try{const r=await fetch("/kristine/api/access-status?token="+encodeURIComponent(token),{cache:"no-store"});draw(await r.json())}catch(e){draw({online:false,services:{}})}}
  function start(){css();if(mount()){load();setInterval(load,5000)}else setTimeout(start,250)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
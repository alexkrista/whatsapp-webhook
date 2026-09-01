"use strict";
(function(){
  if(window.__kristaAccessStatusV4)return;
  window.__kristaAccessStatusV4=true;

  const token=new URLSearchParams(location.search).get("token")||"";
  const BRAIN="https://pc-alex02.tail610122.ts.net";
  const MANAGER="http://127.0.0.1:8765";
  let last=null;
  let servicesHealthy=false;
  const doorHolds=new Map();
  const doorLocks=new Map();
  let gateLockedUntil=0;

  function taskUrl(){
    const u=new URL("/kristine",location.origin);
    if(token)u.searchParams.set("token",token);
    u.hash="tasks";
    return `${u.pathname}${u.search}${u.hash}`;
  }

  function css(){
    if(document.getElementById("kristaAccessV4Css"))return;
    const s=document.createElement("style");
    s.id="kristaAccessV4Css";
    s.textContent=`
      .krista-shell-main.krista-access-v4{
        grid-template-columns:185px minmax(0,1fr) auto!important;
        max-width:1780px!important;
        min-height:64px!important;
        padding:10px 16px!important;
        gap:10px!important;
        align-items:center!important;
      }
      .krista-shell-main.krista-access-v4 .krista-user{display:none!important}
      .krista-shell-main.krista-access-v4 .krista-brand{gap:9px!important}
      .krista-shell-main.krista-access-v4 .krista-mark{width:40px!important;height:40px!important;border-radius:11px!important;font-size:20px!important}
      .krista-shell-main.krista-access-v4 .krista-brand-copy strong{font-size:17px!important}
      .krista-shell-main.krista-access-v4 .krista-brand-copy small{font-size:11px!important;margin-top:3px!important}
      .krista-shell-main.krista-access-v4 .krista-world-nav{
        display:flex!important;flex-wrap:nowrap!important;justify-content:center!important;
        align-items:center!important;gap:5px!important;min-width:0!important;overflow:visible!important;padding:0!important;
      }
      .krista-shell-main.krista-access-v4 .krista-world-link{
        min-height:36px!important;padding:7px 9px!important;border-radius:9px!important;
        gap:5px!important;font-size:11px!important;flex:0 1 auto!important;min-width:0!important;
      }
      .krista-shell-main.krista-access-v4 .krista-world-icon{font-size:13px!important}
      .krista-access-slot{
        display:flex!important;align-items:center!important;justify-content:flex-end!important;
        gap:5px!important;min-width:0!important;white-space:nowrap!important;
      }
      .krista-quick-task,.krista-gate-lamp,.krista-door-lamp,.krista-system-lamp,.krista-services-lamp{
        min-height:34px!important;height:34px!important;margin:0!important;padding:6px 8px!important;
        border:1px solid rgba(255,255,255,.18)!important;border-radius:9px!important;
        background:rgba(255,255,255,.07)!important;color:#fff!important;text-decoration:none!important;
        display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:5px!important;
        font:800 10.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif!important;
        cursor:pointer!important;white-space:nowrap!important;box-sizing:border-box!important;
      }
      .krista-quick-task:hover,.krista-gate-lamp:hover,.krista-door-lamp:hover,.krista-system-lamp:hover,.krista-services-lamp:hover{background:rgba(255,255,255,.14)!important}
      .krista-quick-task.active{background:#2f7d4a!important;border-color:#69a47d!important}
      .krista-system-lamp,.krista-services-lamp{padding-inline:7px!important}
      .krista-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto;background:#e7b34d}
      .krista-dot.green{background:#55c77a}.krista-dot.red{background:#ef6860}.krista-dot.yellow{background:#e7b34d}
      .krista-door-state{font-weight:950!important;opacity:.9}
      .krista-door-lamp.pending,.krista-gate-lamp.pending{opacity:.6!important;pointer-events:none!important}
      .krista-door-lamp.syncing,.krista-gate-lamp.syncing{opacity:.82!important;pointer-events:none!important;cursor:wait!important}

      @media(max-width:1380px){
        .krista-shell-main.krista-access-v4{grid-template-columns:160px minmax(0,1fr) auto!important;padding-inline:10px!important;gap:7px!important}
        .krista-shell-main.krista-access-v4 .krista-brand-copy small{display:none!important}
        .krista-shell-main.krista-access-v4 .krista-world-link{padding-inline:7px!important;font-size:10.5px!important}
        .krista-access-slot{gap:4px!important}
        .krista-door-state{display:none!important}
      }
      @media(max-width:1120px){
        .krista-shell-main.krista-access-v4 .krista-world-icon{display:none!important}
        .krista-shell-main.krista-access-v4 .krista-world-link{padding-inline:6px!important;font-size:10px!important}
        .krista-quick-task{padding-inline:7px!important}
      }
      @media(max-width:900px){
        .krista-shell-main.krista-access-v4{grid-template-columns:minmax(0,1fr) auto!important;padding:8px 10px!important}
        .krista-shell-main.krista-access-v4 .krista-brand{grid-column:1!important}
        .krista-shell-main.krista-access-v4 .krista-mobile-menu{grid-column:2!important}
        .krista-shell-main.krista-access-v4 .krista-world-nav{display:none!important;grid-column:1/-1!important;overflow:visible!important;flex-direction:column!important;align-items:stretch!important}
        .krista-shell-topbar.menu-open .krista-world-nav{display:flex!important}
        .krista-shell-main.krista-access-v4 .krista-world-link{width:100%!important;justify-content:flex-start!important;font-size:12px!important;min-height:38px!important}
        .krista-shell-main.krista-access-v4 .krista-world-icon{display:inline!important}
        .krista-access-slot{grid-column:1/-1!important;justify-content:flex-start!important;overflow-x:auto!important;padding-top:2px!important}
        .krista-door-state{display:inline!important}
      }
    `;
    document.head.appendChild(s);
  }

  function cleanLegacy(main){
    main.querySelectorAll(":scope > a,:scope > button").forEach(el=>{
      if(el.closest("#kristaAccessSlot"))return;
      const text=String(el.textContent||"").replace(/\s+/g," ").trim().toUpperCase();
      if(text==="EINGANG"||text==="SYSTEM"||text==="SYSTEMSTATUS")el.remove();
    });
  }

  function removeTaskFromWorldNav(main){
    const nav=main.querySelector(".krista-world-nav");
    if(!nav)return;
    nav.querySelectorAll("a").forEach(a=>{
      const text=String(a.textContent||"").replace(/\s+/g," ").trim().toUpperCase();
      const href=String(a.getAttribute("href")||"");
      if(text.includes("AUFGABEN")||href.includes("#tasks"))a.remove();
    });
  }

  function mount(){
    const main=document.querySelector(".krista-shell-main");
    if(!main)return null;
    cleanLegacy(main);
    removeTaskFromWorldNav(main);
    main.classList.add("krista-access-v4");
    main.classList.remove("krista-access-v3");
    let slot=document.getElementById("kristaAccessSlot");
    if(!slot){
      slot=document.createElement("div");
      slot.id="kristaAccessSlot";
      slot.className="krista-access-slot";
      main.appendChild(slot);
    }
    return slot;
  }

  function overall(d){
    if(!d?.online)return"red";
    const vals=Object.values(d.services||{});
    if(vals.some(x=>x?.state==="bad"))return"red";
    if(vals.some(x=>x?.state==="warn"))return"yellow";
    return"green";
  }

  function servicesColor(){
    return servicesHealthy?"green":"red";
  }

  function gateColor(d){
    if(!d?.online)return"red";
    const entries=Object.entries(d.services||{});
    const gate=entries.find(([key,x])=>{
      const text=`${key} ${x?.label||""} ${x?.detail||""}`.toLowerCase();
      return text.includes("garagentor")||text.includes("garage")||text.includes("gate");
    });
    return gate&&gate[1]?.state==="bad"?"red":"green";
  }

  function applyDoorHolds(d){
    if(!d)return d;
    const now=Date.now();
    const gantner={...(d.gantner||{})};
    const doors={...(gantner.doors||{})};
    for(const [key,held] of doorHolds.entries()){
      if(now>=held.until){doorHolds.delete(key);continue;}
      const cloudMode=String(doors[key]?.mode||"");
      const heldMode=String(held.door?.mode||"");
      if(cloudMode&&cloudMode===heldMode){doorHolds.delete(key);continue;}
      doors[key]={...(doors[key]||{}),...(held.door||{})};
    }
    gantner.doors=doors;
    return {...d,gantner};
  }

  function isDoorLocked(n){
    const key=String(n);
    const until=Number(doorLocks.get(key)||0);
    if(!until||Date.now()>=until){doorLocks.delete(key);return false;}
    return true;
  }

  function doorVisual(d,x){
    if(!d?.online)return{color:"yellow",state:"?"};
    if(x?.mode==="OPEN")return{color:"green",state:"OFFEN"};
    if(x?.mode==="NORMAL")return{color:"red",state:"ZU"};
    return{color:"yellow",state:"?"};
  }

  function draw(d){
    d=applyDoorHolds(d);
    last=d;
    const slot=mount();
    if(!slot)return;
    const taskActive=location.pathname.toLowerCase().includes("/kristine")&&location.hash.toLowerCase()==="#tasks";
    let h=`<a class="krista-quick-task${taskActive?" active":""}" href="${taskUrl()}" title="Aufgaben öffnen"><span aria-hidden="true">📌</span><span>Aufgaben</span></a>`;
    const gateLocked=Date.now()<gateLockedUntil;
    const gateLamp=gateLocked?"yellow":gateColor(d);
    h+=`<button class="krista-gate-lamp${gateLocked?" syncing":""}" data-gate title="${gateLocked?"Tor-Impuls gesendet · kurz warten":gateLamp==="green"?"Torsteuerung bereit · Klick: Tor-Impuls":"Torsteuerung nicht erreichbar"}"><span class="krista-dot ${gateLamp}"></span><span>TOR</span></button>`;

    const doors=d?.gantner?.doors||{};
    const labels={1:"Eingang",2:"Lager",3:"Büro"};
    for(const n of[1,2,3]){
      const x=doors[String(n)]||{};
      const v=doorVisual(d,x);
      const locked=isDoorLocked(n);
      const action=locked?"Schaltung bestätigt · bitte kurz warten":v.state==="OFFEN"?"Klick: auf ZU stellen":v.state==="ZU"?"Klick: generell öffnen":"Status unbekannt";
      const reason=String(x.reason||"").replace(/"/g,"&quot;");
      h+=`<button class="krista-door-lamp${locked?" syncing":""}" data-door="${n}" title="${action}${reason?" · "+reason:""}"><span class="krista-dot ${v.color}"></span><span>${labels[n]}</span><span class="krista-door-state">${v.state}</span></button>`;
    }
    const svcColor=servicesColor();
    h+=`<button class="krista-services-lamp" data-services title="${svcColor==="green"?"KRISTA Dienste laufen":"KRISTA Dienste nicht erreichbar oder Fehler"}"><span class="krista-dot ${svcColor}"></span><span>Dienste</span></button>`;

    slot.innerHTML=h;
    slot.querySelector("[data-services]")?.addEventListener("click",openServices);
    slot.querySelector("[data-gate]")?.addEventListener("click",e=>pulseGate(e.currentTarget));
    slot.querySelectorAll("[data-door]").forEach(b=>b.addEventListener("click",()=>toggle(b)));
  }

  function openServices(){
    if(typeof window.openKrisadminServices==="function"){window.openKrisadminServices();return;}
    let script=document.querySelector('script[data-krista-services-dialog]');
    if(!script){
      script=document.createElement("script");
      script.src="/public/ui/krisadmin-services.js?v=20260901-lamp1";
      script.setAttribute("data-krista-services-dialog","1");
      script.async=false;
      document.head.appendChild(script);
    }
    let tries=0;
    const timer=setInterval(()=>{
      tries++;
      if(typeof window.openKrisadminServices==="function"){
        clearInterval(timer);window.openKrisadminServices();
      }else if(tries>30){
        clearInterval(timer);location.href="/public/baustellen.html?token="+encodeURIComponent(token);
      }
    },100);
  }

  function updateServicesLamp(){
    const button=document.querySelector("[data-services]");
    if(!button)return;
    const dot=button.querySelector(".krista-dot");
    const color=servicesColor();
    if(dot)dot.className="krista-dot "+color;
    button.title=color==="green"?"KRISTA Dienste laufen":"KRISTA Dienste nicht erreichbar oder Fehler";
  }

  async function loadServicesStatus(){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),2200);
    try{
      const headers={};if(token)headers["X-Krista-Admin-Token"]=token;
      const r=await fetch(MANAGER+"/api/status",{headers,cache:"no-store",signal:controller.signal});
      if(!r.ok)throw new Error("HTTP "+r.status);
      const d=await r.json();
      const rows=Array.isArray(d.rows)?d.rows:[];
      servicesHealthy=Boolean(d.ok)&&!rows.some(x=>String(x?.level||"").toLowerCase()==="red");
    }catch(_){servicesHealthy=false;}
    finally{clearTimeout(timeout);updateServicesLamp();}
  }

  async function pulseGate(btn){
    if(Date.now()<gateLockedUntil)return;
    if(!token){alert("Admin-Token fehlt.");return;}
    btn.classList.add("pending");
    try{
      const r=await fetch(`${BRAIN}/access-control/gate`,{method:"POST",headers:{"X-Krista-Token":token},mode:"cors",cache:"no-store"});
      if(!r.ok)throw new Error("HTTP "+r.status);
      const d=await r.json();if(!d.ok)throw new Error(d.error||"Tor-Impuls fehlgeschlagen");
      gateLockedUntil=Date.now()+10000;if(last)draw(last);
      setTimeout(()=>{gateLockedUntil=0;if(last)draw(last);},10200);
    }catch(e){gateLockedUntil=0;alert("Torsteuerung nicht erreichbar. Tailscale auf diesem Gerät prüfen.");if(last)draw(last);}
  }

  async function toggle(btn){
    const door=Number(btn.dataset.door);
    if(isDoorLocked(door))return;
    if(!token){alert("Admin-Token fehlt.");return;}
    btn.classList.add("pending");
    const dot=btn.querySelector(".krista-dot");if(dot)dot.className="krista-dot yellow";
    const state=btn.querySelector(".krista-door-state");if(state)state.textContent="…";
    try{
      const r=await fetch(`${BRAIN}/access-control/toggle/${door}`,{method:"POST",headers:{"X-Krista-Token":token},mode:"cors",cache:"no-store"});
      if(!r.ok)throw new Error("HTTP "+r.status);
      const d=await r.json();if(!d.ok)throw new Error(d.error||"Schalten fehlgeschlagen");
      const confirmed=d.status?.doors?.[String(door)];
      if(confirmed){doorHolds.set(String(door),{door:{...confirmed},until:Date.now()+8000});doorLocks.set(String(door),Date.now()+6000);}
      if(last&&d.status?.doors){last={...last,gantner:{...(last.gantner||{}),...d.status}};draw(last);}
      setTimeout(load,2500);setTimeout(load,6200);
    }catch(e){doorHolds.delete(String(door));doorLocks.delete(String(door));alert("Türsteuerung nicht erreichbar. Tailscale auf diesem Gerät prüfen.");load();}
  }

  async function load(){
    try{
      const r=await fetch("/kristine/api/access-status?token="+encodeURIComponent(token),{cache:"no-store"});
      if(!r.ok)throw new Error("HTTP "+r.status);
      draw(await r.json());
    }catch(e){draw({online:false,services:{},gantner:{doors:{}}});}
  }

  function start(){
    css();
    if(mount()){
      load();loadServicesStatus();
      setInterval(load,5000);setInterval(loadServicesStatus,5000);
      window.addEventListener("hashchange",()=>setTimeout(()=>{load();loadServicesStatus()},50));
    }else setTimeout(start,250);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});
  else start();
})();
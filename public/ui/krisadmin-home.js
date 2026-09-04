"use strict";

(function(){
  const VERSION="2026-09-04-tower-revenue-live-5";
  const token=new URLSearchParams(location.search).get("token")||"";
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token&&u.origin===location.origin)u.searchParams.set("token",token);return u.pathname+u.search+u.hash};

  function installCss(){
    if(document.getElementById("krisadminHomeCss"))return;
    const s=document.createElement("style");s.id="krisadminHomeCss";s.textContent=`
      body.krisadmin-clean .bar.krista-module-nav,body.krisadmin-clean main>.hint,body.krisadmin-clean main>#app,body.krisadmin-clean main>footer{display:none!important}
      .kah-shell{max-width:1050px;margin:0 auto}.kah-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-end;margin:4px 0 18px}.kah-head h1{margin:0;font-size:28px}.kah-head p{margin:5px 0 0;color:#707670;font-size:12px}.kah-list{display:grid;gap:8px}.kah-row{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:12px;align-items:center;width:100%;border:1px solid #ddd9cf;border-radius:13px;background:#fffefa;padding:12px 14px;color:#252925;text-decoration:none;text-align:left;box-shadow:0 4px 16px rgba(23,33,27,.04);cursor:pointer}.kah-row:hover{border-color:#a8bdaa;background:#fbfdfb}.kah-icon{width:42px;height:42px;border-radius:11px;background:#eef3ee;display:grid;place-items:center;font-size:19px}.kah-copy strong{display:block;font-size:14px}.kah-copy span{display:block;margin-top:3px;color:#707670;font-size:10.5px;line-height:1.4}.kah-arrow{font-size:22px;color:#a4a09a}.kah-row.primary .kah-icon{background:#e5f2e8;color:#245f38}.kah-row.primary{border-color:#c8daca}.kah-row.security .kah-icon{background:#e8f0fb;color:#315d91}.kah-row.system .kah-icon{background:#e8eee9;color:#20372a}.kah-note{margin-top:15px;padding:11px 12px;border-radius:11px;background:#f3f1ea;color:#6d726d;font-size:10.5px;line-height:1.45}.kah-build{font-size:10px;color:#8a8e8a}
      @media(max-width:700px){.kah-head{align-items:flex-start;flex-direction:column}.kah-row{grid-template-columns:40px minmax(0,1fr) 20px;padding:10px}.kah-icon{width:38px;height:38px}.kah-head h1{font-size:24px}}
    `;document.head.appendChild(s);
  }

  function ensureUserAdmin(){
    if(document.querySelector('script[data-krista-user-admin]'))return;
    const s=document.createElement("script");s.src="/public/ui/krisadmin-user-admin.js?v=20260824-users2";s.setAttribute("data-krista-user-admin","1");s.defer=true;document.head.appendChild(s);
  }

  function invoke(name){const fn=window[name];if(typeof fn==="function")return fn();alert("Diese Funktion ist noch nicht geladen. Bitte Seite einmal aktualisieren.")}

  function install(){
    const path=location.pathname.toLowerCase();
    if(!path.includes("/admin")||path.includes("/admin/paint")||path.includes("/admin/akte")||path.includes("/admin/pdf")||path.includes("/admin/download"))return;
    const main=document.querySelector("body>main");if(!main||document.getElementById("krisadminHome"))return;
    installCss();ensureUserAdmin();document.body.classList.add("krisadmin-clean");
    const shell=document.createElement("section");shell.id="krisadminHome";shell.className="kah-shell";
    shell.innerHTML=`<div class="kah-head"><div><h1>KRISADMIN</h1><p>Stammdaten und Verwaltung. Baustellenwissen selbst lebt auf der neuen Baustellenseite.</p></div><span class="kah-build">${VERSION}</span></div><div class="kah-list"><a class="kah-row primary" href="${tokenUrl('/public/baustellen.html')}"><span class="kah-icon">🏗</span><span class="kah-copy"><strong>Baustellen</strong><span>Schmale Übersicht → Klick → komplette Wissensdrehscheibe mit Wirtschaft, Stunden, Fotos, Historie, Regie, Material und Rechnungen.</span></span><span class="kah-arrow">›</span></a><a class="kah-row primary" href="${tokenUrl('/admin/material')}"><span class="kah-icon">📦</span><span class="kah-copy"><strong>Material</strong><span>Artikel suchen, Preise pflegen, neue Materialien anlegen, stilllegen und per Excel aktualisieren.</span></span><span class="kah-arrow">›</span></a><button class="kah-row" type="button" data-kah-action="openEmployees"><span class="kah-icon">👷</span><span class="kah-copy"><strong>Mitarbeiter</strong><span>Stammdaten, Beschäftigung, Dokumente, Größen, Führerschein und persönliche Daten.</span></span><span class="kah-arrow">›</span></button><a class="kah-row security" href="${tokenUrl('/admin/access')}"><span class="kah-icon">🔑</span><span class="kah-copy"><strong>Zutritt</strong><span>Aktive Chips, Gruppen, Hardware-IDs, Büro-Automatik und GAT-Synchronisierung.</span></span><span class="kah-arrow">›</span></a><button class="kah-row security" type="button" data-kah-action="openKrisadminUsers"><span class="kah-icon">🔐</span><span class="kah-copy"><strong>Benutzer & Rechte</strong><span>Benutzerrollen, Aufgabenrechte, Planung, Mitarbeiterdaten und The Brain. Rechnungsfreigaben und Benutzerverwaltung bleiben bei Alexander.</span></span><span class="kah-arrow">›</span></button><button class="kah-row" type="button" data-kah-action="openVehicles"><span class="kah-icon">🚐</span><span class="kah-copy"><strong>Fahrzeuge</strong><span>Fahrzeugstamm, Versicherung, Pickerl, Leasing und Kilometer.</span></span><span class="kah-arrow">›</span></button><button class="kah-row" type="button" data-kah-action="openCompany"><span class="kah-icon">⚙</span><span class="kah-copy"><strong>Betrieb & Kalkulation</strong><span>Betriebliche Grundwerte und Kalkulationsparameter.</span></span><span class="kah-arrow">›</span></button><button class="kah-row system" type="button" data-kah-action="openKrisadminServices"><span class="kah-icon">🩺</span><span class="kah-copy"><strong>System & Dienste</strong><span>Dienstemanager, Systemstatus, Versionen, Git-Stand und Neustarts zentral an einer Stelle.</span></span><span class="kah-arrow">›</span></button></div><div class="kah-note"><strong>Prinzip:</strong> KRISADMIN verwaltet Stammdaten, Zugriffsrechte und Systemverwaltung. Mitarbeiterstatus und Feiertage werden zentral geführt; Zutritt verwendet dieselben Stammdaten und führt keine zweite Pflege ein.</div>`;
    main.insertBefore(shell,main.firstChild);
    shell.querySelectorAll("[data-kah-action]").forEach(b=>b.addEventListener("click",()=>invoke(b.dataset.kahAction)));
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(install,80));else setTimeout(install,80);
})();

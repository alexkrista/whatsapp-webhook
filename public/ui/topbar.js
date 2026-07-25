"use strict";

(function(){
  const WORLD_CONFIG={
    kontrollzentrum:{label:"Kontrollzentrum",icon:"🎛️",href:"/kontrollzentrum",subtitle:"Führung, Entscheidungen und Kommunikation"},
    admin:{label:"Admin",icon:"▦",href:"/admin/ui",subtitle:"Stammdaten und Verwaltung"},
    kristine:{label:"Kristine",icon:"✦",href:"/kristine",subtitle:"Planung, Aufgaben und Organisation"}
  };

  function withToken(href){
    const qs=new URLSearchParams(location.search);
    const token=qs.get("token");
    if(!token)return href;
    return href+(href.includes("?")?"&":"?")+"token="+encodeURIComponent(token);
  }

  function inferWorld(){
    const p=location.pathname.toLowerCase();
    if(p.includes("kontrollzentrum"))return "kontrollzentrum";
    if(p.includes("/admin"))return "admin";
    return "kristine";
  }

  window.createKristaTopbar=function(options={}){
    const active=options.active||inferWorld();
    const mount=document.getElementById(options.mountId||"kristaTopbar");
    if(!mount)return;
    const current=WORLD_CONFIG[active]||WORLD_CONFIG.kontrollzentrum;
    const build=options.build||"0023.18";
    mount.className="krista-shell-topbar";
    mount.innerHTML=`
      <div class="krista-shell-inner">
        <div class="krista-brand">
          <div class="krista-mark" aria-hidden="true">K</div>
          <div class="krista-brand-copy">
            <div class="krista-brand-title">KRISTA</div>
            <div class="krista-brand-sub">${current.subtitle} · Build ${build}</div>
          </div>
        </div>
        <nav class="krista-world-nav" aria-label="Hauptbereiche">
          ${Object.entries(WORLD_CONFIG).map(([key,item])=>`<a class="krista-world-link${key===active?" active":""}" ${key===active?'aria-current="page"':''} href="${withToken(item.href)}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></a>`).join("")}
        </nav>
      </div>`;
    document.body.classList.add("krista-ui");
  };
})();

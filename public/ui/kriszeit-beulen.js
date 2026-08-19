"use strict";

(function(){
  function withToken(path){const u=new URL(path,location.origin),token=new URLSearchParams(location.search).get("token");if(token)u.searchParams.set("token",token);return `${u.pathname}${u.search}${u.hash}`}
  function install(){
    if(!location.pathname.toLowerCase().includes("kristool-preview"))return;
    const actions=document.querySelector(".date-workbench .export-actions");if(!actions)return;
    let left=actions.querySelector(".krista-kriszeit-actions-left");if(!left)return;
    let btn=document.getElementById("openDailyReportKriszeit");
    if(!btn){btn=document.createElement("button");btn.id="openDailyReportKriszeit";btn.type="button";btn.className="btn primary";btn.textContent="▤ Tagesrapport";btn.addEventListener("click",()=>{const date=document.getElementById("dateSelect")?.value||new Date().toISOString().slice(0,10);window.open(withToken(`/admin/daily-report/${date}?rebuild=1`),"_blank","noopener")});left.insertBefore(btn,left.firstChild)}
    if(!document.getElementById("kristaKriszeitDailyReportStyle")){const s=document.createElement("style");s.id="kristaKriszeitDailyReportStyle";s.textContent="#openDailyReportKriszeit{background:#27713d!important;border-color:#27713d!important;color:#fff!important}";document.head.appendChild(s)}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{install();setTimeout(install,250)},{once:true});else{install();setTimeout(install,250)}
})();

"use strict";

(function(){
  function withToken(path){const u=new URL(path,location.origin),token=new URLSearchParams(location.search).get("token");if(token)u.searchParams.set("token",token);return `${u.pathname}${u.search}${u.hash}`}
  function ensureScript(src,key){if(document.querySelector(`script[${key}]`))return;const s=document.createElement("script");s.src=src;s.setAttribute(key,"1");s.defer=true;document.head.appendChild(s)}

  function installNoWorkConfirmation(){
    if(window.__kristaNoWorkConfirmationInstalled)return;
    if(typeof selectedEmployeeScheduledFree!=="function"||typeof ensureCompactReleaseControls!=="function")return;

    const originalScheduledFree=selectedEmployeeScheduledFree;
    selectedEmployeeScheduledFree=function(){
      // Eine fixe Modell-Finkzeit ist ein echter Arbeitstag. Dann darf der
      // Ersatz-Haken "Heute nicht gearbeitet" niemals angeboten werden.
      if(window.__kristaHasFixedModelTime===true)return false;
      if(originalScheduledFree())return true;
      try{
        const item=typeof activeQueueItem==="function"?activeQueueItem():null;
        const absence=typeof absenceLabelForItem==="function"?absenceLabelForItem(item):"";
        const segments=(typeof state!=="undefined"&&Array.isArray(state.segments))?state.segments:[];
        return !absence&&segments.length===0&&window.__kristaHasFixedModelTime!==true;
      }catch{
        return originalScheduledFree();
      }
    };

    const originalEnsureCompactReleaseControls=ensureCompactReleaseControls;
    ensureCompactReleaseControls=function(){
      const result=originalEnsureCompactReleaseControls();
      const button=document.getElementById("releaseModelFreeButton");
      if(button){
        const strong=button.querySelector("strong");
        const small=button.querySelector("small");
        if(strong)strong.textContent="Heute nicht gearbeitet";
        if(small)small.textContent="0:00 h · keine Arbeitszeit";
        button.title="Bestätigt ausdrücklich, dass für diesen Mitarbeiter an diesem Tag keine Arbeitszeit zu erfassen ist.";
      }
      return result;
    };

    window.__kristaNoWorkConfirmationInstalled=true;
    try{if(typeof renderRelease==="function")renderRelease()}catch{}
  }

  function install(){
    if(!location.pathname.toLowerCase().includes("kristool-preview"))return;
    ensureScript("/public/ui/kriszeit-fink-model-v2.js","data-krista-fink-model-v2");
    ensureScript("/public/ui/kriszeit-model-time-column.js","data-krista-model-time-column");
    ensureScript("/public/ui/kriszeit-model-binding-hotfix.js","data-krista-model-binding-hotfix");
    const actions=document.querySelector(".date-workbench .export-actions");if(!actions)return;
    let left=actions.querySelector(".krista-kriszeit-actions-left");if(!left)return;
    let btn=document.getElementById("openDailyReportKriszeit");
    if(!btn){btn=document.createElement("button");btn.id="openDailyReportKriszeit";btn.type="button";btn.className="btn primary";btn.textContent="▤ Tagesrapport";btn.addEventListener("click",()=>{const date=document.getElementById("dateSelect")?.value||new Date().toISOString().slice(0,10);window.open(withToken(`/admin/daily-report/${date}?rebuild=1`),"_blank","noopener")});left.insertBefore(btn,left.firstChild)}
    if(!document.getElementById("kristaKriszeitDailyReportStyle")){const s=document.createElement("style");s.id="kristaKriszeitDailyReportStyle";s.textContent="#openDailyReportKriszeit{background:#27713d!important;border-color:#27713d!important;color:#fff!important}";document.head.appendChild(s)}
    installNoWorkConfirmation();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{install();setTimeout(install,250)},{once:true});else{install();setTimeout(install,250)}
})();

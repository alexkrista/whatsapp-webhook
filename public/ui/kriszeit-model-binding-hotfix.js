"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;

  function norm(value){
    return String(value||"")
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  }

  function expectedModelId(employee){
    const name=norm([employee?.nickname,employee?.name,employee?.employeeName].filter(Boolean).join(" "));
    if(/\balex(?:ander)?\b/.test(name))return "office-alex";
    if(/\bjudith\b/.test(name))return "office-judith";
    if(/\bgeri\b|\bgerry\b/.test(name))return "office-geri";
    return "";
  }

  function currentEmployee(){
    try{
      const id=String(state?.activeEmployeeId||document.getElementById("employeeSelect")?.value||"");
      return (state?.bootstrap?.employees||[]).find(row=>String(row?.id||row?.employeeId||"")===id)||null;
    }catch{return null}
  }

  function repairClientModelBinding(){
    const employee=currentEmployee();
    const expected=expectedModelId(employee);
    if(!employee||!expected)return false;
    if(String(employee.worktimeModelId||"")===expected)return false;

    // Die Tagesprüfung muss für die drei fixen Büromodelle immer das dafür
    // vorgesehene Modell verwenden. Persistiert wird weiterhin ausschließlich
    // über die Mitarbeiterkarte; hier reparieren wir nur einen alten/stale
    // Bootstrap-Wert, damit die Tagesfolie nicht leer bleibt.
    employee.worktimeModelId=expected;
    return true;
  }

  function injectStyle(){
    if(document.getElementById("kristaReleaseCompactHotfix"))return;
    const style=document.createElement("style");
    style.id="kristaReleaseCompactHotfix";
    style.textContent=`
      #releaseCompactGrid{
        grid-template-columns:minmax(0,1fr) 220px!important;
        gap:8px 14px!important;
        align-items:center!important;
        margin:6px 0 10px!important;
      }
      #releaseCheckSummary{
        display:grid!important;
        grid-template-columns:repeat(3,minmax(0,1fr))!important;
        gap:5px 12px!important;
        padding:0!important;
      }
      #releaseCheckSummary>div{
        min-width:0!important;
        font-size:12px!important;
        line-height:1.2!important;
      }
      #releaseCheckSummary>div span:first-child{
        font-size:14px!important;
      }
      #releaseMasterSide{align-self:stretch!important}
      #releaseMasterSide>label{
        min-height:54px!important;
        height:100%!important;
        padding:8px 10px!important;
        font-size:12px!important;
        line-height:1.2!important;
      }
      #releaseModelFreeWrap{margin:0!important}
      .release-card{min-height:0!important;height:auto!important}
      .release-card .release-meta{padding:10px 12px!important}
      .release-card .release-note{padding:9px 12px!important}
      .release-card .release-note textarea{min-height:50px!important;height:50px!important}
      .release-card .release-actions{padding:10px 12px!important;margin:0!important}
      .release-card .release-position{padding:0 12px 8px!important}
      @media(max-width:900px){
        #releaseCompactGrid{grid-template-columns:1fr!important}
        #releaseCheckSummary{grid-template-columns:1fr 1fr!important}
        #releaseMasterSide>label{height:auto!important}
      }
    `;
    document.head.appendChild(style);
  }

  function tick(){
    injectStyle();
    repairClientModelBinding();
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{tick();setTimeout(tick,300)},{once:true});
  else{tick();setTimeout(tick,300)}
  setInterval(tick,1000);
})();

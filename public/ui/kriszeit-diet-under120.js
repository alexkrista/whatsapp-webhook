"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;

  let installed=false;
  let lastSignature="";

  function norm(value){
    return String(value||"")
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  }

  function currentEmployee(){
    try{
      if(typeof currentEmployeeMaster==="function"){
        const employee=currentEmployeeMaster();
        if(employee)return employee;
      }
    }catch{}
    try{
      const id=String(state?.activeEmployeeId||document.getElementById("employeeSelect")?.value||"");
      return (state?.bootstrap?.employees||[]).find(row=>String(row?.id||row?.employeeId||"")===id)||null;
    }catch{return null}
  }

  function isAlex(){
    const employee=currentEmployee();
    const name=norm([employee?.nickname,employee?.name,employee?.employeeName].filter(Boolean).join(" "));
    return /\balex(?:ander)?\b/.test(name);
  }

  function fixedUnder120(){
    // Diese Sonderregel gilt ausschließlich für Alex. Alle anderen behalten
    // ihre bestehenden, individuellen Diätenmodelle unverändert.
    if(!isAlex())return null;

    const card=document.getElementById("finkModelTimeCard");
    if(!card||card.hidden)return null;
    const text=String(card.textContent||"").replace(/\s+/g," ");
    if(!/Baustelle\s*<\s*120\s*km/i.test(text))return null;

    const totalText=String(card.querySelector("footer strong")?.textContent||"");
    const totalMatch=totalText.match(/(\d+):(\d{2})\s*h/i);
    if(!totalMatch)return null;
    const minutes=Number(totalMatch[1])*60+Number(totalMatch[2]);
    if(!Number.isFinite(minutes)||minutes<=0)return null;

    const timeText=String(card.querySelector(".fink-model-time")?.textContent||"");
    const timeMatch=timeText.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);
    return {
      minutes,
      from:timeMatch?.[1]||"07:00",
      to:timeMatch?.[2]||"13:48"
    };
  }

  function under120Allowance(minutes){
    const value=Math.max(0,Number(minutes||0));
    return {
      eligible:value>360,
      type:"site6_under120",
      label:"Diät < 120 km",
      rule:"mehr als 6:00 h Baustelle < 120 km"
    };
  }

  function install(){
    if(installed)return true;
    if(typeof dietCalculation!=="function"||typeof renderDietPanel!=="function")return false;

    const originalDietCalculation=dietCalculation;
    dietCalculation=function(){
      const result=originalDietCalculation.apply(this,arguments)||{};
      const fixed=fixedUnder120();
      if(!fixed)return result;
      const allowance=under120Allowance(fixed.minutes);
      return {
        ...result,
        siteMinutes:fixed.minutes,
        allowanceModel:"site6_under120",
        allowance,
        taggeldAutomatic:allowance.eligible
      };
    };

    const originalRenderDietPanel=renderDietPanel;
    renderDietPanel=function(){
      const fixed=fixedUnder120();
      let restoreSegments=null;
      try{
        // Die Basisfunktion zeigt bei komplett leerer Tagesfolie sonst nur den
        // Leerzustand. Für Alex' fixe 022-Finkzeit reicht ein temporärer Block,
        // der ausschließlich während der Diätenberechnung existiert.
        if(fixed&&typeof state!=="undefined"&&Array.isArray(state.segments)&&state.segments.length===0){
          restoreSegments=state.segments;
          state.segments=[{
            id:"__krista_alex_model_diet_under120__",
            type:"work",
            from:fixed.from,
            to:fixed.to,
            jobId:"",
            jobName:"Baustelle < 120 km",
            reason:"",
            billingType:"normal"
          }];
        }
        return originalRenderDietPanel.apply(this,arguments);
      }finally{
        if(restoreSegments!==null)state.segments=restoreSegments;
      }
    };

    installed=true;
    window.__kristaDietUnder120Installed=true;
    return true;
  }

  function signature(){
    const card=document.getElementById("finkModelTimeCard");
    let employeeId="",date="",segmentCount="";
    try{
      employeeId=String(state?.activeEmployeeId||document.getElementById("employeeSelect")?.value||"");
      date=String(state?.activeDate||document.getElementById("dateSelect")?.value||"");
      segmentCount=String(Array.isArray(state?.segments)?state.segments.length:"");
    }catch{}
    return [employeeId,date,segmentCount,card?.hidden?"hidden":"shown",String(card?.textContent||"").replace(/\s+/g," ").trim()].join("|");
  }

  function tick(){
    if(!install())return;
    const sig=signature();
    if(sig===lastSignature)return;
    lastSignature=sig;
    try{renderDietPanel()}catch{}
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{tick();setTimeout(tick,350)},{once:true});
  else{tick();setTimeout(tick,350)}
  setInterval(tick,700);
})();

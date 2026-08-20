"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;
  if(window.__kristaDietLt120HotfixInstalled)return;

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
  function isAlexFixedLt120(){
    if(window.__kristaHasFixedModelTime!==true)return false;
    const employee=currentEmployee();
    const name=norm([employee?.nickname,employee?.name,employee?.employeeName].filter(Boolean).join(" "));
    return /\balex(?:ander)?\b/.test(name);
  }

  function install(){
    if(window.__kristaDietLt120HotfixInstalled)return true;
    if(typeof window.currentAllowanceModel!=="function"||typeof window.allowanceForMinutes!=="function"||typeof window.dietCalculation!=="function"||typeof window.renderDietPanel!=="function")return false;

    const originalCurrentAllowanceModel=window.currentAllowanceModel;
    window.currentAllowanceModel=function(){
      if(isAlexFixedLt120())return "site_lt120";
      return originalCurrentAllowanceModel.apply(this,arguments);
    };

    const originalAllowanceForMinutes=window.allowanceForMinutes;
    window.allowanceForMinutes=function(model,siteMinutes){
      if(model==="site_lt120"){
        const m=Math.max(0,Number(siteMinutes||0));
        return {
          eligible:m>=360,
          type:"site_lt120",
          label:"Diät < 120 km",
          rule:"022 · ab 6:00 h Baustelle"
        };
      }
      return originalAllowanceForMinutes.apply(this,arguments);
    };

    const originalDietCalculation=window.dietCalculation;
    window.dietCalculation=function(){
      const result=originalDietCalculation.apply(this,arguments)||{};
      if(!isAlexFixedLt120())return result;
      const siteMinutes=Math.max(Number(result.siteMinutes||0),408); // 6:48 h fixe Finkzeit
      const allowance=window.allowanceForMinutes("site_lt120",siteMinutes);
      return {
        ...result,
        siteMinutes,
        allowanceModel:"site_lt120",
        allowance,
        taggeldAutomatic:allowance.eligible
      };
    };

    const originalRenderDietPanel=window.renderDietPanel;
    window.renderDietPanel=function(){
      if(!isAlexFixedLt120())return originalRenderDietPanel.apply(this,arguments);
      let restored=false;
      let originalSegments=null;
      try{
        if(typeof state!=="undefined"&&Array.isArray(state.segments)&&state.segments.length===0){
          originalSegments=state.segments;
          state.segments=[{
            id:"alex_fixed_lt120_diet_preview",
            type:"work",
            from:"07:00",
            to:"13:48",
            jobId:"",
            jobName:"Baustelle < 120 km",
            reason:"022",
            billingType:""
          }];
          restored=true;
        }
        return originalRenderDietPanel.apply(this,arguments);
      }finally{
        if(restored)state.segments=originalSegments;
      }
    };

    window.__kristaDietLt120HotfixInstalled=true;
    try{window.renderDietPanel()}catch{}
    return true;
  }

  if(!install()){
    let tries=0;
    const timer=setInterval(()=>{
      if(install()||++tries>40)clearInterval(timer);
    },100);
  }
})();

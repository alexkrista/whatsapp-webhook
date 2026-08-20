"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("kristool-preview"))return;
  let cache=null;

  function withToken(pathname){const u=new URL(pathname,location.origin),t=new URLSearchParams(location.search).get("token");if(t)u.searchParams.set("token",t);return `${u.pathname}${u.search}`}
  async function loadModels(){
    if(cache)return cache;
    try{
      const r=await fetch(withToken("/kristine/api/worktime-models-v2"),{credentials:"same-origin"});
      const body=await r.json();
      cache=r.ok&&body?.ok!==false&&Array.isArray(body?.models)?body.models:[];
    }catch{cache=[]}
    return cache;
  }
  function modelFor(employee,models){return models.find(m=>String(m?.id||"")===String(employee?.worktimeModelId||""))||null}
  function weekday(iso){const d=new Date(`${iso}T12:00:00`),n=d.getDay();return n===0?7:n}
  function fixedRow(model,date){
    const block=model?.blocks?.finkFixed;
    if(block?.enabled!==true)return null;
    const day=weekday(date);
    return (block.rows||[]).find(row=>Array.isArray(row.days)&&row.days.map(Number).includes(day)&&row.from&&row.to)||null;
  }
  function finkCode(row){const code=String(row?.activityCode||"");return /^\d{3,4}$/.test(code)?code:""}

  function install(){
    if(window.__kristaFinkModelV2Installed)return true;
    if(typeof window.buildFinkRows!=="function")return false;
    const original=window.buildFinkRows;
    window.buildFinkRows=async function(from,to){
      const result=await original(from,to);
      const models=await loadModels();
      const employees=(typeof state!=="undefined"&&Array.isArray(state?.bootstrap?.employees))?state.bootstrap.employees:[];
      if(!models.length||!employees.length)return result;

      for(const employee of employees){
        const model=modelFor(employee,models);if(!model?.blocks?.finkFixed?.enabled)continue;
        const nr=typeof fperson==="function"?fperson(employee):"";if(!nr)continue;
        for(const date of (typeof fdates==="function"?fdates(from,to):[])){
          // Abwesenheit hat Vorrang vor fixer Büro-/Finkzeit.
          try{if(typeof assignmentAbsence==="function"&&assignmentAbsence(employee.id||employee.employeeId,date))continue}catch{}
          const fixed=fixedRow(model,date);if(!fixed)continue;
          const dateLabel=typeof fdate==="function"?fdate(date):date;
          result.rows=(result.rows||[]).filter(r=>!(String(r?.[0]||"")===String(nr)&&String(r?.[2]||"")===String(dateLabel)));
          const name=typeof fname==="function"?fname(employee.name||employee.employeeName):String(employee.name||employee.employeeName||"");
          const duration=typeof fhours==="function"?fhours(fixed.from,fixed.to):"";
          result.rows.push([nr,name,dateLabel,fixed.from,fixed.to,duration,fixed.activityLabel||" ",finkCode(fixed)||" "]);
        }
      }
      result.rows.sort((a,b)=>String(a?.[0]||"").localeCompare(String(b?.[0]||""),"de",{numeric:true})||String(a?.[2]||"").localeCompare(String(b?.[2]||""))||String(a?.[3]||"").localeCompare(String(b?.[3]||"")));
      return result;
    };
    window.__kristaFinkModelV2Installed=true;
    return true;
  }

  if(!install()){let tries=0;const timer=setInterval(()=>{if(install()||++tries>30)clearInterval(timer)},100)}
})();

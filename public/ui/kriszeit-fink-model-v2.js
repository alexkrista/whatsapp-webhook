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
  function min(hm){const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/);return m?Number(m[1])*60+Number(m[2]):null}
  function splitFixed(row){
    const start=min(row.from),end=min(row.to);if(start===null||end===null||end<=start)return [];
    const breaks=[
      {from:row.pauseFrom,to:row.pauseTo,label:"Pause",code:"003"},
      {from:row.lunchFrom,to:row.lunchTo,label:"Pause",code:"003"}
    ].map(b=>({...b,a:min(b.from),z:min(b.to)})).filter(b=>b.a!==null&&b.z!==null&&b.z>b.a&&b.z>start&&b.a<end).sort((a,b)=>a.a-b.a);
    const out=[];let cursor=start;
    const toHm=n=>`${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`;
    for(const br of breaks){
      const a=Math.max(start,br.a),z=Math.min(end,br.z);
      if(a>cursor)out.push({from:toHm(cursor),to:toHm(a),label:row.activityLabel||" ",code:finkCode(row)});
      if(z>a)out.push({from:toHm(a),to:toHm(z),label:br.label,code:br.code});
      cursor=Math.max(cursor,z);
    }
    if(cursor<end)out.push({from:toHm(cursor),to:toHm(end),label:row.activityLabel||" ",code:finkCode(row)});
    return out;
  }

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
          // Urlaub/Krank/Feiertag usw. hat Vorrang vor fixer Büro-/Finkzeit.
          try{if(typeof assignmentAbsence==="function"&&assignmentAbsence(employee.id||employee.employeeId,date))continue}catch{}
          const fixed=fixedRow(model,date);if(!fixed)continue;
          const dateLabel=typeof fdate==="function"?fdate(date):date;
          result.rows=(result.rows||[]).filter(r=>!(String(r?.[0]||"")===String(nr)&&String(r?.[2]||"")===String(dateLabel)));
          const name=typeof fname==="function"?fname(employee.name||employee.employeeName):String(employee.name||employee.employeeName||"");
          for(const part of splitFixed(fixed)){
            const duration=typeof fhours==="function"?fhours(part.from,part.to):"";
            result.rows.push([nr,name,dateLabel,part.from,part.to,duration,part.label||" ",part.code||" "]);
          }
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

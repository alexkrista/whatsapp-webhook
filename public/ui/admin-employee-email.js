"use strict";

(function(){
  const VERSION="2026-08-24-email-1";
  let emails={};
  let cacheLoaded=false;

  function tokenUrl(pathname){
    const url=new URL(pathname,location.origin);
    const token=new URLSearchParams(location.search).get("token");
    if(token)url.searchParams.set("token",token);
    return `${url.pathname}${url.search}`;
  }

  async function api(pathname,options={}){
    const response=await fetch(tokenUrl(pathname),options);
    const text=await response.text();
    let json=null;try{json=text?JSON.parse(text):null}catch{}
    if(!response.ok)throw new Error(json?.error||text||response.statusText);
    return json||{};
  }

  async function loadEmails(){
    try{
      const data=await api("/kristine/api/employee-emails");
      emails=data.emails||{};
      cacheLoaded=true;
    }catch(error){console.warn("Mitarbeiter-Mailadressen konnten nicht geladen werden",error)}
  }

  function installField(){
    if(document.getElementById("empEmail"))return;
    const phone=document.getElementById("empPhone");
    const row=phone?.closest("div");
    if(!row)return;
    const emailRow=document.createElement("div");
    emailRow.innerHTML='<label>E-Mail-Adresse</label><input id="empEmail" type="email" autocomplete="email" placeholder="name@firma.at">';
    row.insertAdjacentElement("afterend",emailRow);
  }

  function activeEmployeeId(){return String(document.getElementById("empEditId")?.value||"").trim()}

  function fillEmail(employeeId){
    installField();
    const input=document.getElementById("empEmail");
    if(input)input.value=emails[String(employeeId||"")]||"";
  }

  async function saveEmail(employeeId,email){
    if(!employeeId)return;
    const value=String(email||"").trim();
    await api(`/kristine/api/employee-emails/${encodeURIComponent(employeeId)}`,{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({email:value})
    });
    if(value)emails[employeeId]=value;else delete emails[employeeId];
  }

  function employeeIds(){
    try{return new Set((Array.isArray(employeeMasters)?employeeMasters:[]).map(e=>String(e?.id||e?.employeeId||"")).filter(Boolean))}
    catch{return new Set()}
  }

  function newestCreatedEmployee(beforeIds,name){
    try{
      const rows=(Array.isArray(employeeMasters)?employeeMasters:[]).filter(e=>!beforeIds.has(String(e?.id||e?.employeeId||"")));
      if(rows.length===1)return rows[0];
      const wanted=String(name||"").trim().toLowerCase();
      return rows.find(e=>String(e?.name||e?.employeeName||"").trim().toLowerCase()===wanted)||null;
    }catch{return null}
  }

  function wrapFunctions(){
    installField();

    if(typeof window.resetEmployeeForm==="function"&&!window.resetEmployeeForm.__kristaEmail){
      const original=window.resetEmployeeForm;
      const wrapped=function(){const result=original.apply(this,arguments);installField();const input=document.getElementById("empEmail");if(input)input.value="";return result};
      wrapped.__kristaEmail=true;window.resetEmployeeForm=wrapped;
    }

    if(typeof window.editEmployeeMaster==="function"&&!window.editEmployeeMaster.__kristaEmail){
      const original=window.editEmployeeMaster;
      const wrapped=function(id){const result=original.apply(this,arguments);if(cacheLoaded)fillEmail(id);else loadEmails().then(()=>fillEmail(id));return result};
      wrapped.__kristaEmail=true;window.editEmployeeMaster=wrapped;
    }

    if(typeof window.saveEmployeeMaster==="function"&&!window.saveEmployeeMaster.__kristaEmail){
      const original=window.saveEmployeeMaster;
      const wrapped=async function(){
        installField();
        const existingId=activeEmployeeId();
        const email=String(document.getElementById("empEmail")?.value||"").trim();
        const name=String(document.getElementById("empName")?.value||"").trim();
        const beforeIds=employeeIds();
        const result=await original.apply(this,arguments);
        let employeeId=existingId;
        if(!employeeId){
          const created=newestCreatedEmployee(beforeIds,name);
          employeeId=String(created?.id||created?.employeeId||"");
        }
        if(employeeId){
          try{await saveEmail(employeeId,email)}
          catch(error){alert("Mitarbeiter gespeichert, aber die E-Mail-Adresse konnte nicht gespeichert werden: "+(error?.message||error))}
        }
        return result;
      };
      wrapped.__kristaEmail=true;window.saveEmployeeMaster=wrapped;
    }
  }

  function boot(){
    if(!location.pathname.toLowerCase().includes("/admin"))return;
    installField();loadEmails();wrapFunctions();
    setTimeout(wrapFunctions,300);setTimeout(wrapFunctions,900);
    setInterval(wrapFunctions,2500);
    console.info("KRISADMIN Mitarbeiter-Mail",VERSION);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();

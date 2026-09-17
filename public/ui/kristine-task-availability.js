(function(){
  "use strict";

  let requestNumber=0;
  let lastDate="";
  let lastRows=[];

  const byId=id=>document.getElementById(id);
  const safe=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
  const minutes=value=>{const match=String(value||"").match(/^(\d{2}):(\d{2})$/);return match?Number(match[1])*60+Number(match[2]):null};
  const isAppointment=()=>document.querySelector('input[name="taskType"]:checked')?.value==="Termin";
  const endpoint=path=>typeof window.url==="function"?window.url(path):path;

  function overlaps(row){
    if(String(row.showAs||"").toLowerCase()==="free")return false;
    if(row.allDay)return true;
    const from=minutes(byId("tAppointmentFrom")?.value),to=minutes(byId("tAppointmentTo")?.value),rowFrom=minutes(row.from),rowTo=minutes(row.to);
    return from!==null&&to!==null&&rowFrom!==null&&rowTo!==null&&from<rowTo&&to>rowFrom;
  }

  function renderRows(date,rows){
    const target=byId("tAppointmentAvailability");if(!target)return;
    target.className="full task-availability";
    if(!date){target.innerHTML='<span class="small">Datum wählen – dann erscheinen hier sofort die gebuchten Termine.</span>';return}
    const day=new Date(`${date}T12:00:00`),label=day.toLocaleDateString("de-AT",{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric"});
    if(!rows.length){target.classList.add("free");target.innerHTML=`<strong>✓ ${safe(label)}: keine Termine</strong>`;return}
    const conflicts=rows.filter(overlaps).length;
    target.innerHTML=`<strong>📅 ${safe(label)}</strong><div class="task-availability-list">${rows.map(row=>`<span class="task-availability-row ${overlaps(row)?"overlap":""}"><b>${row.allDay?"ganztägig":`${safe(row.from||"–")}–${safe(row.to||"–")}`}</b> ${safe(row.title||"Termin")}</span>`).join("")}</div>${conflicts?`<div class="small task-availability-warning">⚠ Überschneidung mit ${conflicts===1?"diesem Termin":"diesen Terminen"}.</div>`:""}`;
  }

  function renderCurrent(){renderRows(lastDate,lastRows)}

  function renderError(error){
    const target=byId("tAppointmentAvailability");if(!target)return;
    const message=String(error?.message||error||"Kalender konnte nicht geladen werden.");
    const needsLogin=/nicht angemeldet|anmeldung|refresh-token|token/i.test(message);
    target.className="full task-availability error";
    target.innerHTML=`<strong>Kalender gerade nicht erreichbar</strong><div class="small">${safe(message)}</div>${needsLogin?'<button type="button" class="secondary" data-outlook-login style="margin-top:9px">Microsoft / Outlook anmelden</button>':""}`;
    target.querySelector("[data-outlook-login]")?.addEventListener("click",loginOutlook);
  }

  async function loginOutlook(event){
    const button=event?.currentTarget,target=byId("tAppointmentAvailability"),microsoftWindow=window.open("about:blank","_blank");
    if(button)button.disabled=true;
    try{
      const response=await fetch(endpoint("/kristine/api/outlook/login/start"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});
      const start=await response.json().catch(()=>({}));if(!response.ok)throw new Error(start.error||"Outlook-Anmeldung konnte nicht gestartet werden.");
      if(microsoftWindow)microsoftWindow.location.href=start.verificationUri;
      target.className="full task-availability loading";target.innerHTML=`<strong>Microsoft-Code ${safe(start.userCode)}</strong><div class="small">Im geöffneten Fenster als alexander.krista@krista.at anmelden. KRISTINE wartet auf die Bestätigung …</div>`;
      for(let attempt=0;attempt<90;attempt++){
        await new Promise(resolve=>setTimeout(resolve,Math.max(5,Number(start.interval||5))*1000));
        const poll=await fetch(endpoint("/kristine/api/outlook/login/poll"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:start.sessionId})});
        const result=await poll.json().catch(()=>({}));if(poll.status===202)continue;if(!poll.ok)throw new Error(result.error||"Outlook-Anmeldung fehlgeschlagen.");
        if(microsoftWindow&&!microsoftWindow.closed)microsoftWindow.close();lastDate="";await refresh(true);return;
      }
      throw new Error("Zeit für die Outlook-Anmeldung abgelaufen.");
    }catch(error){if(microsoftWindow&&!microsoftWindow.closed)microsoftWindow.close();renderError(error)}finally{if(button)button.disabled=false}
  }

  async function refresh(force=false){
    const target=byId("tAppointmentAvailability"),date=byId("tAppointmentDate")?.value||"";if(!target)return;
    if(!isAppointment()||!date){lastDate="";lastRows=[];renderRows("",[]);return}
    if(!force&&date===lastDate){renderCurrent();return}
    const current=++requestNumber;lastDate=date;lastRows=[];target.className="full task-availability loading";target.textContent="Outlook-Termine werden geladen …";
    try{
      const response=await fetch(endpoint(`/kristine/api/outlook/day?date=${encodeURIComponent(date)}`)),body=await response.json().catch(()=>({}));
      if(current!==requestNumber)return;
      if(!response.ok)throw new Error(body.error||"Kalender konnte nicht geladen werden.");
      lastRows=Array.isArray(body.appointments)?body.appointments:[];renderRows(date,lastRows);
    }catch(error){
      if(current!==requestNumber)return;
      renderError(error);
    }
  }

  window.refreshTaskAppointmentAvailability=()=>refresh(false);
  function setup(){
    byId("tAppointmentDate")?.addEventListener("change",()=>refresh(true));
    byId("tAppointmentFrom")?.addEventListener("change",renderCurrent);
    byId("tAppointmentTo")?.addEventListener("change",renderCurrent);
    document.querySelectorAll('input[name="taskType"]').forEach(input=>input.addEventListener("change",()=>refresh(false)));
    refresh(false);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",setup);else setup();
})();

"use strict";

(function(){
  const VERSION="2026-08-27-task-calendar1";
  let currentTask=null;

  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const pad=n=>String(n).padStart(2,"0");

  function taskById(id){
    try{return (typeof data!=="undefined"&&Array.isArray(data.tasks)?data.tasks:[]).find(t=>String(t.id)===String(id))||null}catch{return null}
  }

  function parseExplicitDate(text){
    const source=String(text||"");
    let m=source.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if(m)return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m=source.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
    if(m)return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    return "";
  }

  function parseExplicitTime(text){
    const source=String(text||"");
    const m=source.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:uhr)?\b/i);
    if(!m)return "";
    return `${pad(m[1])}:${pad(m[2])}`;
  }

  function plusHour(hm){
    const m=String(hm||"").match(/^(\d{2}):(\d{2})$/);if(!m)return "";
    let mins=Number(m[1])*60+Number(m[2])+60;mins=Math.min(mins,23*60+59);
    return `${pad(Math.floor(mins/60))}:${pad(mins%60)}`;
  }

  function installStyle(){
    if(document.getElementById("kristaTaskCalendarCss"))return;
    const s=document.createElement("style");s.id="kristaTaskCalendarCss";s.textContent=`
      .krista-calendar-task{background:#315d91!important;border-color:#315d91!important;color:#fff!important;font-weight:800}
      .ktc-bg{position:fixed;inset:0;z-index:80050;display:none;place-items:center;padding:18px;background:rgba(0,0,0,.55)}.ktc-bg.open{display:grid}
      .ktc-modal{width:min(650px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:18px;padding:18px;box-shadow:0 26px 90px rgba(0,0,0,.35)}
      .ktc-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.ktc-head h3{margin:0}.ktc-close{width:38px;min-width:38px;height:38px;padding:0;background:#fff;color:#222;border:1px solid #ccc}
      .ktc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.ktc-grid .full{grid-column:1/-1}.ktc-grid label{font-size:11px;color:#666;margin-bottom:4px}.ktc-grid input,.ktc-grid textarea{width:100%}.ktc-grid textarea{min-height:105px}
      .ktc-all-day{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #ddd;border-radius:10px;background:#faf9f6}.ktc-all-day input{width:auto}
      .ktc-hint{margin-top:10px;padding:10px;border-radius:10px;background:#f4f2ed;color:#626862;font-size:12px}.ktc-hint.warn{background:#fff4d9;color:#765400}
      .ktc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.ktc-actions button{font-weight:800}.ktc-google{background:#27713d!important;border-color:#27713d!important}.ktc-ics{background:#fff!important;color:#222!important}
      @media(max-width:620px){.ktc-bg{padding:8px}.ktc-grid{grid-template-columns:1fr}.ktc-grid .full{grid-column:auto}.ktc-actions button{width:100%}}
    `;document.head.appendChild(s);
  }

  function ensureModal(){
    let bg=document.getElementById("kristaTaskCalendarBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaTaskCalendarBg";bg.className="ktc-bg";
    bg.innerHTML=`<section class="ktc-modal" role="dialog" aria-modal="true" aria-labelledby="ktcTitle"><div class="ktc-head"><div><h3 id="ktcTitle">📅 Termin aus Aufgabe</h3><div class="small">Aufgabeninhalt wird übernommen. Datum und Uhrzeit nur, wenn eindeutig.</div></div><button type="button" class="ktc-close" data-ktc-close>×</button></div><div class="ktc-grid"><div class="full"><label>Titel</label><input id="ktcEventTitle"></div><div><label>Datum</label><input id="ktcDate" type="date"></div><div class="ktc-all-day"><input id="ktcAllDay" type="checkbox"><label for="ktcAllDay" style="margin:0">Ganztägig</label></div><div><label>Von</label><input id="ktcFrom" type="time"></div><div><label>Bis</label><input id="ktcTo" type="time"></div><div class="full"><label>Ort</label><input id="ktcLocation"></div><div class="full"><label>Notiz</label><textarea id="ktcDetails"></textarea></div></div><div id="ktcHint" class="ktc-hint"></div><div class="ktc-actions"><button id="ktcGoogle" type="button" class="ktc-google">📅 In Google Kalender öffnen</button><button id="ktcIcs" type="button" class="ktc-ics">Kalenderdatei (.ics)</button><button type="button" class="secondary" data-ktc-close>Abbrechen</button></div></section>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if(e.target===bg||e.target.closest("[data-ktc-close]"))close()});
    bg.querySelector("#ktcAllDay").addEventListener("change",syncAllDay);
    bg.querySelector("#ktcGoogle").addEventListener("click",openGoogle);
    bg.querySelector("#ktcIcs").addEventListener("click",downloadIcs);
    return bg;
  }

  function syncAllDay(){
    const all=document.getElementById("ktcAllDay")?.checked;
    for(const id of ["ktcFrom","ktcTo"]){const el=document.getElementById(id);if(el)el.disabled=!!all}
  }

  function taskText(task){return [task?.title,task?.reminder,task?.contactName,task?.contactPhone,task?.contactEmail,task?.jobName].filter(Boolean).join("\n")}

  function open(taskId){
    const task=taskById(taskId);if(!task)return;
    currentTask=task;installStyle();const bg=ensureModal();
    const text=taskText(task),date=parseExplicitDate(text),time=parseExplicitTime(text);
    document.getElementById("ktcEventTitle").value=String(task.title||"Termin").replace(/^Rückruf\s+/i,"").trim()||"Termin";
    document.getElementById("ktcDate").value=date;
    document.getElementById("ktcFrom").value=time;
    document.getElementById("ktcTo").value=time?plusHour(time):"";
    document.getElementById("ktcAllDay").checked=false;
    document.getElementById("ktcLocation").value=task.address||task.jobName||"";
    document.getElementById("ktcDetails").value=[task.reminder,task.contactName||task.contactPhone||task.contactEmail?`Kontakt: ${[task.contactName,task.contactPhone,task.contactEmail].filter(Boolean).join(" · ")}`:"",task.jobName?`Baustelle: ${task.jobName}`:""].filter(Boolean).join("\n\n");
    const hint=document.getElementById("ktcHint");
    if(date&&time){hint.className="ktc-hint";hint.textContent="Datum und Uhrzeit wurden eindeutig aus der Aufgabe erkannt. Bitte kurz prüfen."}
    else if(date){hint.className="ktc-hint warn";hint.textContent="Datum erkannt, aber keine eindeutige Uhrzeit. Bitte Von/Bis wählen oder ganztägig markieren."}
    else{hint.className="ktc-hint warn";hint.textContent=`Kein eindeutiges Termindatum im Aufgabentext. Bitte Datum wählen.${task.dueDate?` Aufgaben-Fälligkeit ist ${task.dueDate} – sie wird bewusst nicht automatisch als Termin verwendet.`:""}`}
    syncAllDay();bg.classList.add("open");
  }

  function close(){document.getElementById("kristaTaskCalendarBg")?.classList.remove("open")}

  function values(){
    const title=document.getElementById("ktcEventTitle")?.value.trim()||"Termin";
    const date=document.getElementById("ktcDate")?.value||"";
    const allDay=!!document.getElementById("ktcAllDay")?.checked;
    const from=document.getElementById("ktcFrom")?.value||"";
    const to=document.getElementById("ktcTo")?.value||"";
    const location=document.getElementById("ktcLocation")?.value.trim()||"";
    const details=document.getElementById("ktcDetails")?.value.trim()||"";
    if(!date)throw new Error("Bitte ein Datum wählen.");
    if(!allDay){if(!from||!to)throw new Error("Bitte Von und Bis wählen oder ganztägig markieren.");if(to<=from)throw new Error("Bis muss nach Von liegen.")}
    return {title,date,allDay,from,to,location,details};
  }

  function compactDate(date){return String(date||"").replace(/-/g,"")}
  function googleDates(v){
    if(v.allDay){const d=new Date(v.date+"T12:00:00");d.setDate(d.getDate()+1);const end=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;return `${compactDate(v.date)}/${end}`}
    return `${compactDate(v.date)}T${v.from.replace(":","")}00/${compactDate(v.date)}T${v.to.replace(":","")}00`;
  }

  function openGoogle(){
    let v;try{v=values()}catch(e){alert(e.message);return}
    const u=new URL("https://calendar.google.com/calendar/render");u.searchParams.set("action","TEMPLATE");u.searchParams.set("text",v.title);u.searchParams.set("dates",googleDates(v));u.searchParams.set("ctz","Europe/Vienna");if(v.details)u.searchParams.set("details",v.details);if(v.location)u.searchParams.set("location",v.location);
    window.open(u.href,"_blank","noopener");
  }

  function icsEscape(v){return String(v||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;")}
  function icsLocal(date,time){return `${compactDate(date)}T${String(time||"").replace(":","")}00`}
  function downloadIcs(){
    let v;try{v=values()}catch(e){alert(e.message);return}
    const uid=`kristine-${String(currentTask?.id||Date.now()).replace(/[^A-Za-z0-9_-]/g,"")}@krista.local`;
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//KRISTINE//Aufgabe zu Termin//DE","CALSCALE:GREGORIAN","BEGIN:VEVENT",`UID:${uid}`,`SUMMARY:${icsEscape(v.title)}`];
    if(v.allDay){const d=new Date(v.date+"T12:00:00");d.setDate(d.getDate()+1);const end=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;lines.push(`DTSTART;VALUE=DATE:${compactDate(v.date)}`,`DTEND;VALUE=DATE:${end}`)}else lines.push(`DTSTART;TZID=Europe/Vienna:${icsLocal(v.date,v.from)}`,`DTEND;TZID=Europe/Vienna:${icsLocal(v.date,v.to)}`);
    if(v.location)lines.push(`LOCATION:${icsEscape(v.location)}`);if(v.details)lines.push(`DESCRIPTION:${icsEscape(v.details)}`);lines.push("END:VEVENT","END:VCALENDAR");
    const blob=new Blob([lines.join("\r\n")+"\r\n"],{type:"text/calendar;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Termin-${v.date}.ics`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
  }

  function inject(taskId){
    const list=document.getElementById("taskModalList");if(!list||!taskId)return;
    const item=list.querySelector(".task-modal-item");const actions=item?.querySelector(".actions");if(!actions||actions.querySelector("[data-krista-calendar-task]"))return;
    const b=document.createElement("button");b.type="button";b.className="krista-calendar-task";b.dataset.kristaCalendarTask=String(taskId);b.textContent="📅 Termin anlegen";b.onclick=()=>open(taskId);actions.insertBefore(b,actions.firstChild);
  }

  function hook(){
    const fn=window.openTaskListModal;if(typeof fn!=="function"||fn.__kristaTaskCalendar)return;
    const wrapped=function(focusId=""){const result=fn.apply(this,arguments);if(focusId)setTimeout(()=>inject(String(focusId)),0);return result};
    for(const key of ["__kristaAttachments"])if(fn[key])wrapped[key]=fn[key];wrapped.__kristaTaskCalendar=true;window.openTaskListModal=wrapped;
  }

  function boot(){
    if(!location.pathname.toLowerCase().includes("/kristine"))return;installStyle();ensureModal();hook();
    setTimeout(hook,200);setTimeout(hook,900);setInterval(hook,1800);
    console.info("KRISTINE Aufgabe → Termin",VERSION);
  }

  window.KristineTaskCalendar={open,close,version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();

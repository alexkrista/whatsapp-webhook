"use strict";
(() => {
  const $=id=>document.getElementById(id),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const minute=v=>{const m=/^(\d{1,2}):(\d{2})$/.exec(String(v||""));return m?+m[1]*60+ +m[2]:0},hm=n=>window.KrisMonthly.hm(n);
  const add=(date,n)=>{const d=new Date(date+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
  const monday=date=>add(date,-((new Date(date+"T12:00:00Z").getUTCDay()+6)%7));
  const decimal=n=>(n/60).toLocaleString("de-AT",{minimumFractionDigits:2,maximumFractionDigits:2});
  const total=rows=>rows.filter(r=>["work","up"].includes(r.type)).reduce((sum,r)=>sum+Math.max(0,minute(r.to)-minute(r.from)),0);
  const work=rows=>rows.filter(s=>["work","up"].includes(s.type)&&!["900","901","902","903","904","911","930","945","946"].includes(String(s.unproductiveCode||""))&&!/urlaub|krank|feiertag|zeitausgleich/i.test(s.reason||"")).reduce((n,s)=>n+Math.max(0,minute(s.to)-minute(s.from)),0);
  const kinds={work:"Arbeit / Baustelle",up:"Büro / Sonstiges / Abwesenheit",pause:"Pause",lunch:"Mittag"};
  const reasons=[["","Büro"],["913","Werkstatt"],["900","Urlaub"],["901","Krank"],["904","Feiertag"],["930","Zeitausgleich"],["902","Arzt"],["903","Berufsschule"],["911","Sonderurlaub"]];
  let current=null,loading=false;
  const style=document.createElement("style");style.textContent=`
    #monthlyEmployeeModal{z-index:1100}.employee-review-dialog{width:min(1500px,98vw);max-width:98vw;max-height:96vh;overflow:auto;padding:22px;background:#fff;border-radius:18px}
    .employee-review-head,.employee-review-actions{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;position:sticky;background:#fff;z-index:2;padding:12px 0}.employee-review-head{top:-22px}.employee-review-actions{bottom:-22px;border-top:1px solid #ddd}
    .employee-review-head h2{margin:0}.employee-review-status{padding:12px;border-radius:8px;background:#edf6ed;margin:8px 0}.employee-review-status.closed{background:#fff0d1;border:2px solid #a56700}.employee-review-table{width:100%;border-collapse:collapse;font-size:14px}.employee-review-table th,.employee-review-table td{padding:9px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.employee-review-table th{background:#edf1ed}
    .employee-review-table .over-limit{background:#ffe3de;color:#8b2014;font-weight:700}.employee-review-table .week-total{background:#edf1ed;font-weight:700}.employee-review-table small{display:block;color:#57625b}.review-block{white-space:nowrap;margin-bottom:5px}.review-block span{display:inline-block;min-width:112px}.review-edit-grid{display:grid;grid-template-columns:180px 105px 105px minmax(180px,1fr) 45px;gap:8px;margin:8px 0}.review-edit-grid input,.review-edit-grid select{width:100%;min-width:0;padding:8px}.review-edit-box{background:#f5f7f5;padding:12px}.review-edit-box textarea{width:100%;min-height:65px}.employee-review-summary{display:flex;gap:20px;flex-wrap:wrap;padding:12px;background:#edf6ed}.review-warning{color:#a32618;font-weight:700}.review-scroll{overflow-x:auto}@media(max-width:700px){.review-edit-grid{grid-template-columns:1fr 85px 85px 36px}.review-edit-grid .review-context{grid-column:1/-1}.employee-review-dialog{padding:12px}.employee-review-table td{padding:6px}}
  `;document.head.appendChild(style);
  const modal=document.createElement("div");modal.id="monthlyEmployeeModal";modal.className="logic-modal";modal.hidden=true;
  modal.innerHTML='<section class="employee-review-dialog" role="dialog" aria-modal="true" aria-labelledby="employeeReviewTitle"><div class="employee-review-head"><div><h2 id="employeeReviewTitle">Monatskontrolle</h2><div id="employeeReviewModel"></div></div><button type="button" class="btn secondary" data-review-exit>Schließen</button></div><div id="employeeReviewStatus" class="employee-review-status" role="status"></div><div id="employeeReviewContent"></div><div class="employee-review-actions"><span id="employeeReviewSaveStatus" role="status"></span><div><button type="button" class="btn secondary" data-review-save>Änderungen speichern</button> <button type="button" class="btn secondary" data-review-pdf>PDF</button> <button type="button" class="btn primary" data-review-close>Speichern &amp; Monat abschließen</button></div></div></section>';
  document.body.appendChild(modal);
  function dirty(){return current&&Object.keys(current.drafts).length>0}
  function message(text,error=false){$("employeeReviewSaveStatus").textContent=text;$("employeeReviewSaveStatus").className=error?"review-warning":""}
  function setBusy(value){loading=value;modal.querySelectorAll("[data-review-save],[data-review-close],[data-review-pdf],[data-review-reopen]").forEach(b=>b.disabled=value||Boolean(current?.closed&&!b.hasAttribute("data-review-pdf")&&!b.hasAttribute("data-review-reopen")))}
  async function load(){
    const c=current,first=monday(c.from),last=window.KrisMonthly.reportTo(add(monday(c.to),6));
    const data=await request(`/kristine/api/monthly-days/${encodeURIComponent(c.id)}?from=${first}&to=${last}`);
    if(c!==current)return;
    c.days=data.days;c.drafts={};c.closed=c.days.some(d=>d.date>=c.from&&d.date<=c.to&&d.monthClosed);
    await window.KrisMonthly.refreshClosures(c.from.slice(0,7));
    c.person=await window.KrisMonthly.buildPerson(c.employee,c.from,c.to,c.za);
    render();
  }
  async function open(id){
    if(loading)return;if(dirty()&&!confirm("Ungespeicherte Änderungen verwerfen?"))return;
    const item=window.KrisMonthly.personItem(id);if(!item)return;
    const from=$("monthlyFrom").value,to=window.KrisMonthly.reportTo($("monthlyTo").value);
    current={id,employee:item.employee,za:item.za,from,to,days:[],drafts:{},closed:false};
    modal.hidden=false;$("employeeReviewContent").textContent="Tageszeiten werden geladen …";setBusy(true);
    try{await load();message("Von/Bis und Stunden aus denselben Daten wie das PDF. Änderungen werden erst mit Speichern übernommen.")}
    catch(error){message(error.message,true)}finally{setBusy(false)}
  }
  function render(){
    const c=current,person=c.person;
    $("employeeReviewTitle").textContent=(c.employee.name||c.id)+" · "+c.from+" bis "+c.to;
    $("employeeReviewModel").textContent="Arbeitszeitmodell: "+(person.modelLabel||"")+" · Personalnummer: "+(person.personnelNumber||"–");
    const status=$("employeeReviewStatus");status.className="employee-review-status"+(c.closed?" closed":"");
    status.innerHTML=c.closed?'<strong>Monat abgeschlossen – Stunden gesperrt.</strong> Abschluss und PDF bleiben unverändert. Änderungen erfordern eine ausdrückliche Wiederöffnung mit Begründung. <button class="btn secondary" type="button" data-review-reopen>Abgeschlossenen Monat wieder öffnen</button>':'<strong>Offener Monat.</strong> Rot markiert: mehr als 10 Arbeitsstunden pro Tag bzw. mehr als 50 pro Kalenderwoche. Pausen und bezahlte Abwesenheiten zählen dafür nicht als Arbeit. Randwochen enthalten auch die Tage außerhalb des Monats.';
    const byDate=new Map(person.days.map(d=>[d.date,d])),days=c.days.filter(d=>d.date>=c.from&&d.date<=c.to),weeks=new Map();
    for(const d of c.days){const key=monday(d.date);weeks.set(key,(weeks.get(key)||0)+work(c.drafts[d.date]?.segments||d.segments))}
    let html='<div class="employee-review-summary"><strong>Stunden: '+hm(person.totals.actualMinutes)+' ('+decimal(person.totals.actualMinutes)+' Std.)</strong><span>Soll: '+hm(person.totals.targetMinutes)+'</span><span>Saldo: '+decimal(person.totals.balanceMinutes)+' Std.</span></div><div class="review-scroll"><table class="employee-review-table"><thead><tr><th>Tag</th><th>Arbeitszeiten Von–Bis · Dauer</th><th>Stunden</th><th>Soll</th><th>Saldo</th><th>Kontrolle</th></tr></thead><tbody>';
    days.forEach((d,index)=>{
      const r=byDate.get(d.date)||{},segments=c.drafts[d.date]?.segments||d.segments,working=work(segments),paid=total(segments),shown=c.drafts[d.date]?paid:r.actualMinutes??paid;
      html+='<tr'+(working>600?' class="over-limit"':'')+'><td>'+esc(new Date(d.date+"T12:00:00").toLocaleDateString("de-AT",{weekday:"short",day:"2-digit",month:"2-digit"}))+'</td><td>'+ (segments.length?segments.map(s=>'<div class="review-block"><span>'+esc(s.from)+'–'+esc(s.to||"offen")+'</span> '+hm(Math.max(0,minute(s.to)-minute(s.from)))+' · '+esc(s.reason||kinds[s.type]||s.type)+'</div>').join(""):'–')+'<small>'+esc(d.source)+'</small></td><td>'+hm(shown)+'<small>'+decimal(shown)+' Std.</small>'+(working>600?'<strong>Über 10 Std.: +'+hm(working-600)+'</strong>':'')+'</td><td>'+hm(d.targetMinutes)+'</td><td>'+decimal(shown-d.targetMinutes)+'</td><td>'+(d.released?"Freigegeben / Modell":"Noch nicht freigegeben")+(!c.closed?'<br><button class="btn secondary" type="button" data-review-edit="'+d.date+'">Bearbeiten</button>'+(!d.released?' <button class="btn secondary" type="button" data-review-release="'+d.date+'">Tag freigeben</button>':'')+'':'')+'</td></tr>';
      html+='<tr id="review-editor-'+d.date+'" hidden><td colspan="6"></td></tr>';
      if(index===days.length-1||monday(days[index+1].date)!==monday(d.date)){const sum=weeks.get(monday(d.date))||0;html+='<tr class="week-total'+(sum>3000?' over-limit':'')+'"><td colspan="2">Wochensumme Arbeit · '+esc(monday(d.date))+' bis '+esc(add(monday(d.date),6))+'</td><td colspan="4">'+hm(sum)+' · '+decimal(sum)+' Std.'+(sum>3000?' · Über 50 Std.: +'+hm(sum-3000):'')+'</td></tr>'}
    });
    $("employeeReviewContent").innerHTML=html+'</tbody></table></div>';setBusy(loading);
  }
  function editor(date){
    const c=current,d=c.days.find(d=>d.date===date);if(!d||c.closed)return;
    if(!c.drafts[date])c.drafts[date]={segments:JSON.parse(JSON.stringify(d.segments)),reason:""};
    const draft=c.drafts[date],row=$("review-editor-"+date);row.hidden=false;
    row.firstElementChild.innerHTML='<div class="review-edit-box"><strong>'+esc(date)+' · Zeitblöcke bearbeiten</strong><div>'+draft.segments.map((s,i)=>'<div class="review-edit-grid" data-review-segment="'+i+'"><select data-field="type" aria-label="Art">'+Object.entries(kinds).map(([key,value])=>'<option value="'+key+'"'+(s.type===key?' selected':'')+'>'+value+'</option>').join("")+'</select><input type="time" data-field="from" aria-label="Von" value="'+esc(s.from)+'"><input type="time" data-field="to" aria-label="Bis" value="'+esc(s.to)+'"><div class="review-context">'+(s.type==="up"?'<select data-field="absence" aria-label="Tätigkeit oder Abwesenheit">'+reasons.map(([code,label])=>'<option value="'+code+'"'+(String(s.unproductiveCode||"")===code?' selected':'')+'>'+label+'</option>').join("")+'</select>':'<span>'+esc(s.jobName||s.reason||"")+'</span>')+'</div><button type="button" class="btn secondary" data-review-remove="'+i+'" aria-label="Block löschen">×</button></div>').join("")+'</div><button type="button" class="btn secondary" data-review-add>+ Zeitblock</button><label>Änderungsgrund (wird protokolliert)<textarea data-review-reason>'+esc(draft.reason)+'</textarea></label><small>Bei Arbeit bleiben vorhandene Baustellenzuordnungen erhalten. Fixe Lohnzeiten ändern keine Baustellenstunden.</small><div data-draft-total>Neue Tagessumme: '+hm(total(draft.segments))+'</div></div>';
    row.dataset.date=date;
  }
  function capture(row){
    const draft=current.drafts[row.dataset.date];if(!draft)return;
    row.querySelectorAll("[data-review-segment]").forEach(block=>{
      const s=draft.segments[+block.dataset.reviewSegment],oldType=s.type;
      s.type=block.querySelector('[data-field="type"]').value;s.from=block.querySelector('[data-field="from"]').value;s.to=block.querySelector('[data-field="to"]').value;
      const absence=block.querySelector('[data-field="absence"]');if(absence&&s.type==="up"&&String(s.unproductiveCode||"")!==absence.value){const hit=reasons.find(([code])=>code===absence.value);s.unproductiveCode=hit?.[0]||"";s.reason=hit?.[1]||s.reason;s.unproductiveCategory=s.unproductiveCode==="900"?"vacation":s.unproductiveCode==="901"?"sick":"other";s.absenceType=({"900":"urlaub","901":"krank","904":"feiertag","930":"za","902":"arzt","911":"sonderurlaub"})[s.unproductiveCode]||""}
      if(s.type==="up"&&oldType!=="up"){s.reason="Büro";s.unproductiveCode="";s.unproductiveCategory="other"}
      if(s.type!=="up"&&oldType==="up"){s.reason="";s.unproductiveCode="";s.unproductiveCategory="";s.absenceType=""}
    });
    draft.reason=row.querySelector("[data-review-reason]").value;
    row.querySelector("[data-draft-total]").textContent="Neue Tagessumme: "+hm(total(draft.segments));message("Ungespeicherte Änderungen.");
  }
  async function save(){
    const c=current;if(c.closed)throw new Error("Monat abgeschlossen – Stunden gesperrt.");
    for(const [date,draft] of Object.entries(c.drafts)){const original=c.days.find(d=>d.date===date);if(JSON.stringify(draft.segments)===JSON.stringify(original.segments)&&!draft.reason.trim())delete c.drafts[date]}
    for(const [date,draft] of Object.entries(c.drafts)){
      if(draft.reason.trim().length<5)throw new Error(date+": Bitte einen nachvollziehbaren Änderungsgrund eingeben.");
      const sorted=draft.segments.slice().sort((a,b)=>String(a.from).localeCompare(String(b.from)));
      for(let i=0;i<sorted.length;i++){const s=sorted[i];if(!s.from||!s.to||minute(s.to)<=minute(s.from)||(i&&minute(sorted[i-1].to)>minute(s.from)))throw new Error(date+": Zeiten prüfen – offen, ungültig oder überlappend.")}
    }
    for(const [date,draft] of Object.entries(c.drafts)){
      const d=c.days.find(d=>d.date===date),url=d.payrollFixed?"/kristine/api/monthly-payroll/":"/kristine/api/segments/";
      await request(url+encodeURIComponent(c.id)+"/"+date,{method:"PUT",body:JSON.stringify({employeeName:c.employee.name,segments:draft.segments,reason:draft.reason,correctedBy:"Bettina / Büro"})});
      delete c.drafts[date];message(date+" gespeichert.");
    }
    window.KrisMonthly.invalidate();await load();message("Alle Änderungen gespeichert.");
  }
  async function closeMonth(){
    if(current.closed)return;
    const c=current,month=c.from.slice(0,7),last=add(month+"-01",new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()-1);
    if(c.from!==month+"-01"||c.to!==last||last>=new Date().toISOString().slice(0,10))throw new Error("Zum Abschluss einen vollständigen vergangenen Monat auswählen.");
    await save();
    if(!confirm(month+" für "+c.employee.name+" verbindlich abschließen? Die Stunden werden gespeichert und danach gesperrt. Spätere Änderungen erfordern eine deutliche Warnung, Begründung und Wiederöffnung."))return;
    await request("/kristine/api/month-close",{method:"POST",body:JSON.stringify({month,people:[c.person]})});
    window.KrisMonthly.invalidate();await load();message("Monat gespeichert und abgeschlossen. Stunden sind gesperrt.");
  }
  document.addEventListener("click",event=>{const button=event.target.closest("[data-person-review]");if(button){event.preventDefault();event.stopPropagation();open(button.dataset.personReview)}});
  modal.addEventListener("change",event=>{const row=event.target.closest("[data-date]");if(row){const type=event.target.matches('[data-field="type"]');capture(row);if(type)editor(row.dataset.date)}});
  modal.addEventListener("input",event=>{const row=event.target.closest("[data-date]");if(row)capture(row)});
  modal.addEventListener("click",async event=>{
    const b=event.target.closest("button");if(!b||loading)return;
    if(b.hasAttribute("data-review-exit")){if(!dirty()||confirm("Ungespeicherte Änderungen verwerfen?")){modal.hidden=true;current=null;window.KrisMonthly.refresh().catch(e=>toast(e.message,true))}return}
    if(b.dataset.reviewEdit){editor(b.dataset.reviewEdit);return}
    const row=b.closest("[data-date]");
    if(row&&b.hasAttribute("data-review-add")){capture(row);const segments=current.drafts[row.dataset.date].segments,last=segments.at(-1);segments.push({id:"review_"+Date.now(),type:"up",from:last?.to||"07:00",to:"",reason:"Büro",unproductiveCategory:"other",unproductiveCode:""});editor(row.dataset.date);return}
    if(row&&b.hasAttribute("data-review-remove")){capture(row);current.drafts[row.dataset.date].segments.splice(+b.dataset.reviewRemove,1);editor(row.dataset.date);return}
    setBusy(true);
    try{
      if(b.dataset.reviewRelease){
        if(dirty())throw new Error("Bitte Änderungen vor der Tagesfreigabe speichern.");
        if(!confirm(b.dataset.reviewRelease+": Zeiten, Regieberichte, Tagesabschluss, Diäten sowie FL/CH-Zuordnung geprüft und Tag freigeben?"))return;
        await request("/kristine/api/day-release/"+encodeURIComponent(current.id)+"/"+b.dataset.reviewRelease,{method:"PUT",body:JSON.stringify({employeeName:current.employee.name,reviewer:"Bettina / Büro",checks:{times:true,regie:true,close:true,diet:true,fl:true,ch:true}})});
        window.KrisMonthly.invalidate();await load();message("Tag geprüft und freigegeben.");
      }
      if(b.hasAttribute("data-review-save"))await save();
      if(b.hasAttribute("data-review-close"))await closeMonth();
      if(b.hasAttribute("data-review-pdf")){if(dirty())throw new Error("Bitte Änderungen vor dem PDF speichern.");await window.KrisMonthly.showPdf(current.person);message("PDF bereit.")}
      if(b.hasAttribute("data-review-reopen")){
        if(!confirm("ACHTUNG: Dieser Monat ist abgeschlossen. Wiederöffnung hebt die Stundensperre für diesen Mitarbeiter auf. Der bisherige Abschluss bleibt als Historie erhalten. Wirklich wieder öffnen?"))return;
        const reason=prompt("Begründung für die Wiederöffnung (wird dauerhaft protokolliert):");if(reason===null)return;
        await request("/kristine/api/month-reopen",{method:"POST",body:JSON.stringify({month:current.from.slice(0,7),employeeId:current.id,reason,acknowledge:true,reviewer:"Bettina / Büro"})});
        window.KrisMonthly.invalidate();await load();message("Monat mit Begründung wieder geöffnet. Nach Korrektur erneut abschließen.");
      }
    }catch(error){message(error.message,true)}finally{setBusy(false)}
  });
})();

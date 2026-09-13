(()=>{
  "use strict";
  const $=id=>document.getElementById(id),esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])),labels={projectFile:"Projektakte",regie:"Regieberichte",communication:"Nachrichten",projectPoints:"Punkte & Wünsche"};
  const number=value=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:2}).format(Number(value)||0),money=value=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR"}).format(Number(value)||0);
  let ticket=new URLSearchParams(location.hash.slice(1)).get("zugang")||"",data=null,selected="";
  history.replaceState(null,"",location.pathname);
  const api=async(path,options={})=>{const response=await fetch("/kundenportal/api/"+path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}}),body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(Error(body.error||"Das hat nicht funktioniert. Bitte erneut versuchen."),{status:response.status});return body};
  const access=message=>{$("project").hidden=true;$("access").hidden=false;$("logout").hidden=true;$("accessMessage").textContent=message;$("enter").hidden=!ticket};
  async function load(){
    try{data=await api("project");$("access").hidden=true;$("project").hidden=false;$("logout").hidden=false;$("preview").hidden=!data.preview;$("closeProject").disabled=!!data.preview;$("downloadCloseProject").disabled=!!data.preview;$("number").textContent=(data.number.startsWith("S")?"Sammelmappe ":"Baustelle ")+data.number;$("name").textContent=data.name;$("greeting").textContent="Willkommen"+(data.customerName?", "+data.customerName:"")+". Hier finden Sie Ihre freigegebenen Unterlagen.";
      const enabled=Object.keys(labels).filter(key=>data.modules[key]);if(!enabled.includes(selected))selected=enabled[0]||"";
      $("tabs").innerHTML=enabled.map(key=>`<button data-tab="${key}" aria-current="${key===selected}">${labels[key]}</button>`).join("");$("tabs").querySelectorAll("button").forEach(button=>button.onclick=()=>{selected=button.dataset.tab;render();for(const row of $("tabs").querySelectorAll("button"))row.setAttribute("aria-current",String(row===button))});render();
    }catch(e){access(e.message)}
  }
  function fileLink(file){return `<a class="button" href="${esc(file.url)}" target="_blank" rel="noopener">${esc(file.name||"PDF öffnen")}</a>`}
  const date=value=>/^\d{4}-\d{2}-\d{2}/.test(value||"")?String(value).slice(0,10).split("-").reverse().join("."):"";
  const pointTitle=row=>row.title||String(row.text||"").split(/\r?\n/)[0].slice(0,100)||row.area||"Punkt oder Wunsch";
  const pointStatus=row=>row.status==="done"?"Erledigt":row.history?.some(event=>event.status==="done")?"Wieder offen":"Eingegangen";
  const pointTime=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString("de-AT",{dateStyle:"medium",timeStyle:"short"}):"Zeitpunkt nicht gespeichert";
  function pointTable(rows){
    return `<section class="card point-list"><div class="point-list-head"><h3>Ihre Punkte & Wünsche</h3><button id="refreshPoints" type="button">Aktualisieren</button></div>${rows.length?`<p class="meta">${rows.length} ${rows.length===1?"Eintrag":"Einträge"} · Neueste zuerst · Zum Öffnen auf eine Zeile klicken.</p><div class="point-table-wrap"><table class="point-table"><caption class="sr-only">Punkte und Wünsche mit Datum, Status und Überschrift</caption><thead><tr><th scope="col">Datum</th><th scope="col">Status</th><th scope="col">Überschrift</th></tr></thead><tbody>${rows.map(row=>`<tr data-point="${esc(row.id)}" class="${row.status==="done"?"done":""}"><td><time datetime="${esc(row.date)}">${esc(date(row.date)||"–")}</time></td><td><span class="point-badge ${row.status==="done"?"done":""}">${pointStatus(row)}</span></td><td><button class="point-title" type="button" aria-haspopup="dialog">${esc(pointTitle(row))}</button>${row.area?`<span class="meta point-area">${esc(row.area)}</span>`:""}</td></tr>`).join("")}</tbody></table></div>`:'<p class="meta">Noch keine Punkte oder Wünsche erfasst.</p>'}</section><dialog id="pointDetail" class="point-detail" aria-labelledby="pointDetailTitle"></dialog>`;
  }
  function openPoint(row){
    const dialog=$("pointDetail"),events=row.history?.length?row.history:[{kind:"submitted",status:"open",date:row.date}];
    dialog.innerHTML=`<div class="point-detail-head"><p class="eyebrow">Punkt & Wunsch</p><button type="button" id="closePointDetail" autofocus>Schließen</button></div><h2 id="pointDetailTitle">${esc(pointTitle(row))}</h2><p><span class="point-badge ${row.status==="done"?"done":""}">${pointStatus(row)}</span></p><p class="meta">Erfasst ${esc(pointTime(row.date))}${row.area?" · "+esc(row.area):""}</p><h3>Beschreibung</h3><p class="text">${esc(row.text)}</p><h3>Verlauf</h3><ol class="point-history">${events.map(event=>`<li><strong>${event.kind==="submitted"?"Erfasst und an Farben Krista übergeben":event.status==="done"?"Erledigt":"Wieder geöffnet"}</strong><br><time class="meta"${event.date?` datetime="${esc(event.date)}"`:""}>${esc(pointTime(event.date))}</time></li>`).join("")}</ol>`;
    $("closePointDetail").onclick=()=>dialog.close();dialog.showModal();
  }
  function renderMaterials(){
    const rows=data.materials||[],partial=data.materialStatus?.complete===false;
    return `<h2 id="portalMaterials">Materialien & Oberflächen</h2>${partial?'<p class="notice">Ein Teil der Materialnachweise konnte noch nicht geladen werden. Die bereits vorhandenen Angaben bleiben sichtbar.</p>':""}<div class="grid">${rows.map(row=>`<article class="card"><p class="meta">Akte ${esc(row.jobId)}</p><h3>${esc(row.name)}</h3>${row.use?`<p>Einsatz: ${esc(row.use)}</p>`:""}${(row.sources||[]).map(source=>`<p>${source.quantity===null?"Menge nicht angegeben":number(source.quantity)+" "+esc(source.unit)}<br><span class="meta">${esc([source.source,source.reference,date(source.date)].filter(Boolean).join(" · "))}</span></p>`).join("")}</article>`).join("")||(!partial?'<p>In den freigegebenen Akten sind noch keine Materialangaben hinterlegt.</p>':"")}</div>`;
  }
  function renderInvoices(){
    const rows=data.invoices||[],partial=data.invoiceStatus?.complete===false,kinds={TR:"Teilrechnung",SR:"Schlussrechnung",RE:"Rechnung",GS:"Gutschrift",ST:"Stornorechnung"};
    return `<h2 id="portalInvoices">Rechnungen</h2>${data.invoiceStatus?.syncedAt?`<p class="meta">Gespeicherter Rechnungsstand vom ${esc(new Date(data.invoiceStatus.syncedAt).toLocaleString("de-AT"))}</p>`:""}${partial?'<p class="notice">Der Rechnungsstand ist noch nicht für alle freigegebenen Akten übernommen.</p>':""}<div class="grid">${rows.map(row=>`<article class="card"><p class="meta">${esc(date(row.date))} · Akte ${esc(row.jobId)}</p><h3>${esc(kinds[row.kind]||"Rechnung")} ${esc(row.number)}</h3><p><strong>${money(row.gross)} brutto</strong><br><span class="meta">${money(row.net)} netto</span></p>${row.url?`<button data-invoice-pdf="${esc(row.url)}">Original-PDF öffnen</button><p class="meta" role="status"></p>`:'<p class="meta">Original-PDF noch nicht übernommen.</p>'}</article>`).join("")||(!partial?'<p>Noch keine ausgestellten Rechnungen hinterlegt.</p>':"")}</div>`;
  }
  function bindInvoiceButtons(){
    $("content").querySelectorAll("[data-invoice-pdf]").forEach(button=>button.onclick=async()=>{
      const message=button.nextElementSibling,popup=window.open("about:blank","_blank");if(popup)popup.opener=null;
      button.disabled=true;message.textContent="Original-PDF wird geladen …";
      try{
        const response=await fetch(button.dataset.invoicePdf);
        if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||"Das Original-PDF konnte nicht geladen werden.");}
        const blob=await response.blob(),url=URL.createObjectURL(blob);
        if(popup)popup.location.replace(url);else{const link=document.createElement("a");link.href=url;link.download="Rechnung.pdf";link.click();}
        setTimeout(()=>URL.revokeObjectURL(url),60000);message.textContent="Original-PDF geöffnet.";
      }catch(error){popup?.close();message.textContent=error.message;}finally{button.disabled=false;}
    });
  }
  function render(){
    $("status").textContent="";const host=$("content");
    if(selected==="projectFile"){
      const docs=data.files.filter(file=>file.group==="documents"),photos=data.files.filter(file=>file.group==="photos");
      host.innerHTML=`<nav aria-label="Inhalte der Projektakte"><a href="#portalDocuments">Dokumente</a><a href="#portalInvoices">Rechnungen</a><a href="#portalPhotos">Fotos</a><a href="#portalMaterials">Materialien</a></nav><details class="card"><summary>${data.projects.length} ${data.projects.length===1?"Einzelakte":"Einzelakten"}</summary>${data.projects.map(row=>`<p><strong>${esc(row.jobId)} · ${esc(row.name)}</strong><br><span class="meta">${esc(row.address)}</span></p>`).join("")}</details><h2 id="portalDocuments">Dokumente</h2><div class="grid">${docs.map(file=>`<article class="card"><p class="meta">Akte ${esc(file.jobId)}</p>${fileLink(file)}</article>`).join("")||'<p>Derzeit sind keine Dokumente bereitgestellt.</p>'}</div>${renderInvoices()}<h2 id="portalPhotos">Fotos</h2><div class="grid">${photos.map(file=>`<figure class="card">${file.type==="video"?`<video class="photo" src="${esc(file.url)}" controls preload="none"></video>`:`<a href="${esc(file.url)}" target="_blank" rel="noopener"><img class="photo" src="${esc(file.url)}" alt="${esc(file.name)}" loading="lazy"></a>`}<figcaption>${esc(file.name)}<br><span class="meta">${esc(file.date)} · Akte ${esc(file.jobId)}</span></figcaption></figure>`).join("")||'<p>Derzeit sind keine Fotos bereitgestellt.</p>'}</div>${renderMaterials()}`;
      bindInvoiceButtons();
    }else if(selected==="regie"){
      host.innerHTML=`<h2>Regieberichte</h2>${data.reports.map(row=>`<article class="card"><p class="meta">${esc(row.date)} · Akte ${esc(row.jobId)}</p><h3>${esc(row.number)}</h3><p><strong>${number(row.hours)} h${row.net?" · "+money(row.net):""}</strong></p><p class="text">${esc(row.description)}</p><p class="meta">${esc(row.employees)}</p>${row.materials.length?`<details><summary>Material</summary>${row.materials.map(m=>`<p>${esc(m.name)} · ${number(m.quantity)} ${esc(m.unit)}</p>`).join("")}</details>`:""}${row.url?fileLink({...row,name:"Original-PDF öffnen"}):""}</article>`).join("")||'<p>Derzeit sind keine Regieberichte bereitgestellt.</p>'}${data.reports.length?`<div class="totals"><span>Summe Regieberichte</span><span>${number(data.reports.reduce((sum,row)=>sum+row.hours,0))} h</span></div>`:""}`;
    }else if(["communication","projectPoints"].includes(selected)){
      const rows=data.points.filter(row=>row.module===selected).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
      host.innerHTML=`<h2>${labels[selected]}</h2><form id="messageForm" class="card">${selected==="projectPoints"?'<label>Überschrift<input name="title" maxlength="140" placeholder="z. B. Fensterbank nachbessern"></label><label>Raum oder Bereich<input name="area" maxlength="140" placeholder="z. B. Wohnzimmer"></label>':""}<label>${selected==="communication"?"Ihre Nachricht":"Ihr Punkt oder Wunsch"}<textarea name="text" maxlength="5000" required></textarea></label><button class="primary" ${data.preview?"disabled":""}>An Farben Krista übergeben</button></form>${selected==="projectPoints"?pointTable(rows):rows.map(row=>`<article class="card"><p class="meta">${esc(date(row.date))} · ${pointStatus(row)}</p><h3>${esc(row.area)}</h3><p class="text">${esc(row.text)}</p></article>`).join("")}`;
      if(selected==="projectPoints"){
        host.querySelectorAll("[data-point]").forEach(tr=>tr.onclick=()=>{const row=rows.find(row=>row.id===tr.dataset.point);if(row)openPoint(row);});
        $("refreshPoints").onclick=async event=>{event.currentTarget.disabled=true;await load();};
      }
      $("messageForm").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector("button");button.disabled=true;try{await api("point",{method:"POST",headers:{"x-csrf-token":data.csrf},body:JSON.stringify({module:selected,title:form.elements.title?.value||"",text:form.elements.text.value,area:form.elements.area?.value||""})});await load();$("status").textContent="Ihr Eintrag ist eingegangen und liegt Farben Krista als Aufgabe vor."}catch(e){$("status").textContent=e.message;button.disabled=false}};
    }else host.innerHTML='<p>Aktuell ist kein Bereich freigegeben.</p>';
  }
  let exportBusy=false,downloadToClose="";
  const csrfOptions=body=>({method:"POST",headers:{"x-csrf-token":data.csrf},body:JSON.stringify(body)});
  async function downloadProject(closeAfter=false){
    if(exportBusy)return;exportBusy=true;downloadToClose="";
    $("downloadProject").disabled=true;$("downloadCloseProject").disabled=true;$("confirmDownloadClose").hidden=true;$("exportMissing").textContent="";
    $("exportStatus").textContent="Ihre freigegebenen Unterlagen werden als ZIP-Datei vorbereitet …";
    try{
      const job=await api("exports",csrfOptions({}));let result;
      for(;;){
        result=await api("exports/"+job.id);
        if(result.status==="failed")throw Error(result.error);
        if(result.status==="ready")break;
        $("exportStatus").textContent=`Projektakte wird vorbereitet · ${result.fileCount||0} Dateien zusammengestellt …`;
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      $("exportStatus").innerHTML=`<a class="button" id="preparedDownload" href="${esc(result.downloadUrl)}" download>ZIP-Datei herunterladen</a>`;
      $("preparedDownload").click();
      if(!result.complete){$("exportMissing").innerHTML=`<p class="notice">Der Download enthält den verfügbaren Stand. Noch nicht enthalten:</p><ul>${(result.missing||[]).map(text=>`<li>${esc(text)}</li>`).join("")}</ul><p>Ihr Zugang bleibt geöffnet.</p>`;}
      else if(closeAfter){downloadToClose=job.id;$("confirmDownloadClose").hidden=false;$("exportMissing").textContent="Bitte prüfen, dass die ZIP-Datei auf Ihrem Gerät gespeichert ist. Danach können Sie den Zugang schließen.";}
    }catch(error){$("exportStatus").textContent=error.message;}
    finally{exportBusy=false;$("downloadProject").disabled=false;$("downloadCloseProject").disabled=!!data?.preview;}
  }
  async function closeProject(afterExport=""){
    if(!data||data.preview)return;
    if(!afterExport&&!window.confirm("Möchten Sie Ihren Online-Zugang schließen? Die Projektunterlagen bleiben bei Farben Krista erhalten."))return;
    try{await api("close",csrfOptions(afterExport?{afterExport}:{}));data=null;access("Ihr Kundenzugang ist geschlossen. Wenn Sie wieder Zugang benötigen, wenden Sie sich bitte an Farben Krista.");}
    catch(error){$("exportStatus").textContent=error.message;}
  }
  $("downloadProject").onclick=()=>downloadProject(false);
  $("downloadCloseProject").onclick=()=>downloadProject(true);
  $("closeProject").onclick=()=>closeProject();
  $("confirmDownloadClose").onclick=()=>closeProject(downloadToClose);
  $("enter").onclick=async()=>{$("enter").disabled=true;try{await api("session",{method:"POST",body:JSON.stringify({ticket})});ticket="";await load()}catch(e){access(e.message)}finally{$("enter").disabled=false}};
  $("logout").onclick=async()=>{try{await api("logout",{method:"POST",body:"{}"});data=null;access("Sie sind abgemeldet. Zum erneuten Öffnen verwenden Sie Ihren persönlichen Einladungslink.")}catch(e){$("status").textContent=e.message}};
  if(ticket)access("Mit Ihrem persönlichen Link öffnen Sie die von Farben Krista freigegebene Projektakte.");else load();
})();

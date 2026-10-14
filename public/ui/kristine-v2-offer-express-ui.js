"use strict";
/* Client-only Offer Express. All data stays in this browser tab, no API calls. */
(function(){
  const Core=window.KristaOfferExpressCore;
  if(!Core)throw Error("KRISTINE Express model not loaded");
  const $=id=>document.getElementById(id);
  const escape=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&#39;"}[c]));
  const pretty=n=>n===null||n===undefined?"":String(n).replace(".",",");
  const toValue=v=>v===null||v===undefined?"":String(v);
  let draft=null, selectedTemplate="innen", undoStack=[],notice="",started=0,focusedSection="";
  const catalogByKey=k=>Core.template(k);
  const packageNames={innen:"Innenmalerei komplett",einfach:"Schnell ausmalen",tapete:"Tapete",fassade:"Fassade",bad:"Fugenloses Bad",regie:"Regie"};
  const measures=[["walls","Wände m²"],["ceiling","Decke m²"],["floor","Boden m²"],["linear","Laufmeter"],["pieces","Stück"]];
  function flash(message,isError=false){const el=$("ox-message");if(!el)return;el.textContent=message;el.className=isError?"ox-message error":"ox-message"}
  function remember(){if(draft){undoStack.push(JSON.stringify(draft));if(undoStack.length>22)undoStack.shift()}}
  function getSection(id){return Core.getSection(draft,id)}
  function download(name,content,type){
    const blob=new Blob([content],{type:type||"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),250);
  }
  function formatQty(n){return n==null?"—":new Intl.NumberFormat("de-AT",{maximumFractionDigits:2}).format(n)}
  function sectionMenu(){
    return (draft.sections||[]).map((s,i)=>'<a href="#ox-section-'+escape(s.id)+'">'+escape(String(i+1))+' · '+escape(s.name)+'</a>').join("");
  }
  function roomUI(sec,r){
    const labels=measures.map(([k,label])=>'<label>'+label+'<input inputmode="decimal" data-measure="'+k+'" data-section="'+escape(sec.id)+'" data-room="'+escape(r.id)+'" value="'+escape(pretty(r.measures[k]))+'" placeholder="—"></label>').join("");
    return '<div class="ox-room"><div class="ox-room-top"><span>Raum / Bauteil</span><input aria-label="Raumname" data-room-name="'+escape(r.id)+'" data-section="'+escape(sec.id)+'" value="'+escape(r.name)+'"></div><div class="ox-measures">'+labels+'</div></div>';
  }
  function positionUI(sec,p,i){
    const roomChoices=sec.rooms.map(r=>'<option value="'+escape(r.id)+'" '+(r.id===p.roomId?"selected":"")+'>'+escape(r.name)+'</option>').join("");
    const measureChoices=[["manual","Eigene Menge"],...Core.MEASURES.map(k=>[k,Core.BASIS_LABELS[k]])].map(([k,name])=>'<option value="'+escape(k)+'" '+(k===p.basis?"selected":"")+'>'+escape(name)+'</option>').join("");
    const rowTotal=p.quantity!==null&&p.unitPrice!==null?Core.money(p.quantity*p.unitPrice):"—";
    const rateBadge=p.unitPrice===null?'<span class="ox-rate-alert">Preis fehlt</span>':
      p.priceConfirmed?'<span class="ox-rate-good">✓ bestätigt</span>':'<button type="button" class="ox-confirm" data-action="confirm" data-section="'+escape(sec.id)+'" data-pos="'+escape(p.id)+'" title="Musterpreis bestätigen">Preis prüfen ✓</button>';
    return '<div class="ox-position" data-pos-row="'+escape(p.id)+'"><div class="ox-position-line">'+
      '<strong class="ox-pos-number">'+(i+1).toString().padStart(2,"0")+'</strong>'+
      '<input class="ox-pos-description" aria-label="Leistungstext" data-text="'+escape(p.id)+'" data-section="'+escape(sec.id)+'" value="'+escape(p.text)+'">'+
      '<input class="ox-pos-qty" inputmode="decimal" aria-label="Menge" data-qty="'+escape(p.id)+'" data-section="'+escape(sec.id)+'" value="'+escape(pretty(p.quantity))+'" placeholder="Menge">'+
      '<input class="ox-pos-unit" aria-label="Einheit" data-unit="'+escape(p.id)+'" data-section="'+escape(sec.id)+'" value="'+escape(p.unit)+'">'+
      '<input class="ox-pos-rate" inputmode="decimal" aria-label="Einzelpreis netto" data-rate="'+escape(p.id)+'" data-section="'+escape(sec.id)+'" value="'+escape(pretty(p.unitPrice))+'" placeholder="Preis">'+
      '<strong class="ox-pos-total">'+escape(rowTotal)+'</strong>'+
      '<button class="ox-remove" type="button" title="Position entfernen" data-action="remove" data-section="'+escape(sec.id)+'" data-pos="'+escape(p.id)+'">×</button></div>'+
      '<div class="ox-position-meta"><label>Menge aus <select data-basis="'+escape(p.id)+'" data-section="'+escape(sec.id)+'">'+measureChoices+'</select></label>'+
      '<label>Bauteil <select data-position-room="'+escape(p.id)+'" data-section="'+escape(sec.id)+'">'+roomChoices+'</select></label>'+
      rateBadge+
      '<span class="ox-pos-move"><button type="button" data-action="up" data-section="'+escape(sec.id)+'" data-pos="'+escape(p.id)+'" title="Position nach oben">↑</button><button type="button" data-action="down" data-section="'+escape(sec.id)+'" data-pos="'+escape(p.id)+'" title="Position nach unten">↓</button><button type="button" data-action="copy" data-section="'+escape(sec.id)+'" data-pos="'+escape(p.id)+'" title="Position kopieren">⧉ Kopieren</button></span></div></div>';
  }
  function sectionUI(s,i){
    const missing=s.positions.filter(p=>p.quantity===null||p.unitPrice===null||!p.priceConfirmed).length;
    const items=s.positions.map((p,ix)=>positionUI(s,p,ix)).join("")||'<div class="ox-empty">Noch keine Positionen. Leistungspaket oder Einzelposition wählen.</div>';
    const options=Core.CATALOG.map(c=>'<option value="'+escape(c.key)+'">'+escape(c.group+" · "+c.text)+'</option>').join("");
    const groups=Object.entries(packageNames).map(([k,label])=>'<button type="button" data-action="package" data-section="'+escape(s.id)+'" data-key="'+escape(k)+'">'+escape(label)+'</button>').join("");
    return '<article class="ox-section" id="ox-section-'+escape(s.id)+'"><header><div class="ox-section-num">'+(i+1)+'</div><div class="ox-section-head"><label>ABSCHNITT</label><input data-section-name="'+escape(s.id)+'" value="'+escape(s.name)+'"></div><span class="ox-muted">'+s.positions.length+' Positionen</span><button type="button" class="ox-collapse" data-action="toggle" data-section="'+escape(s.id)+'">'+(focusedSection===s.id?"Schließen":"Öffnen")+'</button></header>'+
      '<div class="ox-section-body" '+(focusedSection&&focusedSection!==s.id?"hidden":"")+'>'+
      '<div class="ox-section-hint">Aufmaß pro Raum / Bauteil – eine Menge kann beliebig vielen Positionen zugeordnet werden.</div>'+
      '<div class="ox-room-list">'+s.rooms.map(r=>roomUI(s,r)).join("")+'</div>'+
      '<button type="button" class="ox-lite" data-action="room" data-section="'+escape(s.id)+'">+ Raum / Bauteil</button>'+
      '<div class="ox-position-head"><h3>Leistungspositionen <small>'+s.positions.length+' einzeln bearbeitbar</small></h3><span class="ox-muted">'+missing+' ungeprüft</span></div>'+
      '<div class="ox-position-list">'+items+'</div>'+
      '<div class="ox-add"><label>Einzelposition aus dem Katalog <select data-catalog="'+escape(s.id)+'">'+options+'</select></label><button type="button" class="ox-primary small" data-action="add-one" data-section="'+escape(s.id)+'">+ Position</button><button type="button" class="ox-lite" data-action="add-free" data-section="'+escape(s.id)+'">+ Freie Position</button></div>'+
      '<details class="ox-package-box"><summary>Mehrere Positionen mit einem Klick hinzufügen</summary><div>'+groups+'</div><small>Alle eingefügten Positionen bleiben einzeln löschbar.</small></details>'+
      '</div></article>';
  }
  function renderPaper(){
    if(!draft)return;
    const totals=Core.sum(draft);
    const paper=$("ox-paper");
    const bySection=draft.sections.map((s,i)=>{
      const rows=s.positions.map((p,j)=>{
        const room=s.rooms.find(x=>x.id===p.roomId);
        const valid=p.quantity!==null&&p.unitPrice!==null;
        return '<tr><td>'+String(i+1)+'.'+String(j+1)+'</td><td><strong>'+escape(p.text)+'</strong><small>'+escape(room?.name||"")+'</small></td>'+
          '<td>'+escape(formatQty(p.quantity))+'</td><td>'+escape(p.unit)+'</td><td>'+escape(p.unitPrice===null?"—":Core.money(p.unitPrice))+'</td><td><strong>'+escape(valid?Core.money(p.quantity*p.unitPrice):"—")+'</strong></td></tr>';
      }).join("");
      return '<div class="ox-paper-section"><h3>'+String(i+1)+'. '+escape(s.name)+'</h3><table><thead><tr><th>Pos.</th><th>Leistung</th><th>Menge</th><th>EH</th><th>EP</th><th>Gesamt</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }).join("");
    paper.innerHTML='<div class="ox-paper-top"><div class="ox-paper-brand">FARBEN KRISTA <small>ANGEBOTSENTWURF · DEMO</small></div><div class="ox-paper-date">'+new Intl.DateTimeFormat("de-AT").format(new Date())+'</div></div>'+
      '<div class="ox-paper-recipient"><span>AN</span><strong>'+escape(draft.customer||"Kunde noch eintragen")+'</strong><p>'+escape(draft.title||"Angebot")+'</p></div>'+
      '<h2>Angebot <small>Musteransicht – nicht versandfertig</small></h2>'+bySection+
      '<div class="ox-paper-total"><div><span>Positionswert (soweit berechenbar)</span><b>'+escape(Core.money(totals.net))+'</b></div><div><span>20 % USt.</span><b>'+escape(Core.money(totals.vat))+'</b></div><div class="ox-paper-grand"><span>Brutto, vorläufig</span><strong>'+escape(Core.money(totals.gross))+'</strong></div></div>'+
      '<p class="ox-paper-warning">'+(totals.ready?"Alle Positionen vollständig – Musterpreise bestätigt.":"Nicht vollständig: "+totals.missingQuantity+" Mengen offen · "+totals.missingRate+" Preise fehlen · "+totals.unconfirmedRate+" Musterpreise nicht bestätigt.")+'</p>'+
      '<footer>TESTVORSCHAU • Noch keine rechtsverbindliche Angebotsnummer • Kein Live-Dokument</footer>';
    $("ox-subtotal").textContent=Core.money(totals.net);
    $("ox-issues").textContent=(totals.missingQuantity+totals.missingRate+totals.unconfirmedRate)+" offene Prüfungen";
    $("ox-count").textContent=String(totals.lines);
  }
  function render(){
    if(!draft)return;
    $("ox-launch").hidden=true;$("ox-workspace").hidden=false;
    $("ox-title").value=draft.title;
    $("ox-customer-name").value=draft.customer;
    $("ox-section-nav").innerHTML=sectionMenu();
    $("ox-sections").innerHTML=draft.sections.map(sectionUI).join("");
    $("ox-undo").disabled=undoStack.length===0;
    renderPaper();
  }
  function create(){
    const customer=$("ox-customer").value.trim(),title=$("ox-project").value.trim(),brief=$("ox-brief").value.trim();
    if(!customer||!brief){flash("Bitte Kunde und kurze Leistungsbeschreibung eingeben.",true);return}
    started=Date.now();undoStack=[];
    draft=Core.fromBrief(customer,title||"Malerarbeiten",brief,selectedTemplate);
    focusedSection=draft.sections[0].id;
    Core.validate(draft);
    render();
    flash("Entwurf erstellt: "+Core.sum(draft).lines+" Positionen. Mengen und Preise vor dem Versand prüfen.");
  }
  function showDemo(){
    $("ox-customer").value="Familie Wallner (Musterkunde)";
    $("ox-project").value="Eingang + Stiegenhaus";
    $("ox-brief").value="Eingang und Stiegenhaus: Wände 48,20 m², Decke 16,40 m², Boden 16,40 m², Acrylfugen 22 m. Abdecken, spachteln, grundieren, streichen und Acrylfugen herstellen.";
    selectedTemplate="innen";document.querySelectorAll("[data-template]").forEach(x=>x.classList.toggle("active",x.dataset.template===selectedTemplate));
    flash("Beispieldaten eingesetzt. Auf „Entwurf erstellen“ klicken.");
  }
  function action(button){
    if(!draft)return;
    const name=button.dataset.action,secId=button.dataset.section,posId=button.dataset.pos,s=getSection(secId);
    if(name==="toggle"){focusedSection=focusedSection===secId?"":secId;render();return}
    if(name==="undo"){
      const old=undoStack.pop();if(!old)return;
      draft=JSON.parse(old);render();flash("Letzte Aktion rückgängig gemacht.");return;
    }
    if(name==="add-section"){
      const nameText=$("ox-new-section-name").value.trim()||"Weiterer Abschnitt";
      const mode=$("ox-copy-mode").value,copy=$("ox-copy-positions").checked;
      remember();
      const source=draft.sections[draft.sections.length-1];
      const ns=Core.addSection(draft,nameText,mode,source.id);
      if(copy&&mode!=="neu")for(const p of source.positions){
        const q=Core.addPosition(draft,ns.id,p.templateKey,ns.rooms[0].id);
        if(q){Object.assign(q,{text:p.text,unit:p.unit,unitPrice:p.unitPrice,priceConfirmed:p.priceConfirmed,basis:p.basis,quantity:p.basis==="manual"?p.quantity:q.quantity})}
      }
      focusedSection=ns.id;render();$("ox-copy-positions").checked=false;
      flash("Abschnitt angelegt: Aufmaß "+(mode==="neu"?"neu":mode==="uebernehmen"?"übernommen":"zur Ergänzung übernommen")+".");
      return;
    }
    if(!s)return;
    if(name==="room"){remember();Core.addRoom(draft,secId,"Weiterer Raum",false);focusedSection=secId;render();return}
    if(name==="add-one"){
      const select=document.querySelector('[data-catalog="'+secId+'"]');
      remember();Core.addPosition(draft,secId,select?.value||"paint");focusedSection=secId;render();return;
    }
    if(name==="add-free"){
      remember();const p=Core.addPosition(draft,secId,"paint");if(p)Object.assign(p,{templateKey:"free",text:"Neue freie Leistungsposition",unit:"PA",quantity:1,basis:"manual",unitPrice:null,priceConfirmed:false});
      focusedSection=secId;render();return;
    }
    if(name==="package"){
      remember();Core.addPackage(draft,secId,button.dataset.key);focusedSection=secId;render();
      flash("Paket eingefügt – jede Position kann einzeln gelöscht werden.");return;
    }
    if(name==="remove"){
      remember();Core.removePosition(draft,secId,posId);render();flash("Position entfernt. Sie erscheint nicht automatisch wieder.");return;
    }
    if(name==="up"||name==="down"){
      remember();Core.movePosition(draft,secId,posId,name==="up"?-1:1);render();return;
    }
    if(name==="copy"){
      const p=s.positions.find(x=>x.id===posId);if(!p)return;
      remember();const q=Core.addPosition(draft,secId,p.templateKey==="free"?"paint":p.templateKey,p.roomId);
      if(q)Object.assign(q,{...JSON.parse(JSON.stringify(p)),id:q.id});render();return;
    }
    if(name==="confirm"){
      const p=s.positions.find(x=>x.id===posId);if(p&&p.unitPrice!==null){remember();p.priceConfirmed=true;render()}return;
    }
  }
  function editField(el){
    if(!draft)return;
    const secId=el.dataset.section,pid=el.dataset.text||el.dataset.qty||el.dataset.unit||el.dataset.rate||el.dataset.basis||el.dataset.positionRoom;
    const s=secId?getSection(secId):null,p=s?.positions.find(x=>x.id===pid);
    if(el.dataset.sectionName){const sec=getSection(el.dataset.sectionName);if(sec)sec.name=el.value;renderPaper();return}
    if(el.dataset.roomName){const r=s?.rooms.find(x=>x.id===el.dataset.roomName);if(r)r.name=el.value;renderPaper();return}
    if(el.dataset.measure){Core.changeRoomMeasure(draft,secId,el.dataset.room,el.dataset.measure,el.value);renderPaper();return}
    if(!p)return;
    if(el.dataset.text)p.text=el.value;
    else if(el.dataset.qty)Core.setQuantity(draft,secId,pid,el.value);
    else if(el.dataset.unit)p.unit=el.value;
    else if(el.dataset.rate)Core.setRate(draft,secId,pid,el.value);
    else if(el.dataset.basis)Core.setBasis(draft,secId,pid,el.value);
    else if(el.dataset.positionRoom)Core.setRoom(draft,secId,pid,el.value);
    renderPaper();
  }
  function speech(){
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition){flash("Sprachdiktat wird von diesem Browser nicht unterstützt. Bitte Text eingeben.",true);return}
    const recorder=new Recognition();recorder.lang="de-AT";recorder.interimResults=false;recorder.maxAlternatives=1;
    flash("Diktat gestartet. Browser-Mikrofonfreigabe beachten.");
    recorder.onresult=e=>{$("ox-brief").value=($("ox-brief").value.trim()+" "+e.results[0][0].transcript).trim();flash("Diktat übernommen – bitte Wortlaut prüfen.");};
    recorder.onerror=e=>flash("Diktat nicht verfügbar: "+e.error,true);
    recorder.start();
  }
  function init(){
    showDemo();
    document.querySelectorAll("[data-template]").forEach(b=>b.onclick=()=>{selectedTemplate=b.dataset.template;document.querySelectorAll("[data-template]").forEach(x=>x.classList.toggle("active",x===b))});
    $("ox-generate").onclick=create;
    $("ox-demo").onclick=showDemo;
    $("ox-microphone").onclick=speech;
    $("ox-undo").onclick=()=>action({dataset:{action:"undo"}});
    $("ox-new").onclick=()=>{
      if(!draft||confirm("Testentwurf verwerfen? Er wird nicht automatisch gespeichert.")){
        draft=null;undoStack=[];$("ox-launch").hidden=false;$("ox-workspace").hidden=true;flash("Bereit für neuen Entwurf.");
      }
    };
    $("ox-export").onclick=()=>{
      if(!draft)return;
      download("KRISTINE-Express-TEST-"+new Date().toISOString().slice(0,10)+".json",JSON.stringify(draft,null,2));
      flash("Testentwurf als JSON lokal gesichert. Keine Übertragung nach LIVE.");
    };
    $("ox-import").onchange=async e=>{
      const file=e.target.files?.[0];if(!file)return;
      try{
        const obj=JSON.parse(await file.text());Core.validate(obj);draft=obj;undoStack=[];focusedSection=obj.sections?.[0]?.id||"";render();flash("Lokalen Testentwurf geladen.");
      }catch(err){flash("Import abgelehnt: "+err.message,true)}
      e.target.value="";
    };
    $("ox-print").onclick=()=>{if(!draft)return;window.print()};
    $("ox-title").oninput=e=>{draft.title=e.target.value;renderPaper()};
    $("ox-customer-name").oninput=e=>{draft.customer=e.target.value;renderPaper()};
    $("ox-workspace").addEventListener("click",e=>{const b=e.target.closest("button[data-action]");if(b)action(b)});
    $("ox-workspace").addEventListener("input",e=>editField(e.target));
    $("ox-workspace").addEventListener("change",e=>{editField(e.target);if(e.target.matches("[data-basis],[data-position-room]"))render()});
    $("ox-workspace").addEventListener("focusout",e=>{
      if(e.target.matches("[data-text],[data-qty],[data-rate],[data-unit],[data-measure]"))render();
    });
    $("ox-workspace").addEventListener("click",e=>{
      const link=e.target.closest('a[href^="#ox-section"]');
      if(link){const sec=link.hash.replace("#ox-section-","");if(getSection(sec)){focusedSection=sec;render();setTimeout(()=>document.getElementById("ox-section-"+sec)?.scrollIntoView({behavior:"smooth",block:"start"}),0)}}
    },true);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();

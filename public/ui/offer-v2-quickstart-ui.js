"use strict";
(function(){
  const C=window.KristaOfferV2,Q=window.KristaOfferV2Quick;
  if(!C||!Q)throw Error("KRISTINE Angebots-V2-Kern nicht erreichbar");
  const $=id=>document.getElementById(id),KEY="krista.angebot-v2.isolated-preview.v1";
  let preset="innen",offer=null;
  function message(value,isError=false){
    const el=$("quickMessage");el.textContent=value;el.classList.toggle("bad",!!isError);
  }
  function example(){
    $("quickCustomer").value="Familie Wallner (Test)";
    $("quickTitle").value="Eingang + Stiegenhaus";
    $("quickBrief").value="Eingang und Stiegenhaus: Wände 48,20 m², Decke 16,40 m², Boden 16,40 m², Acrylfugen 22 m. Abdecken, spachteln, grundieren, streichen und Acrylfugen herstellen.";
    preset="innen";
    document.querySelectorAll("[data-preset]").forEach(b=>b.classList.toggle("active",b.dataset.preset===preset));
    message("Beispiel eingetragen. Auf „Bearbeitbaren Entwurf erstellen“ klicken.");
  }
  const fmt=value=>value==null?"":String(value).replace(".",",");
  const money=value=>C.currency(Number(value)||0);
  function current(){
    if(!offer)return {};
    const sec=offer.sections[0],room=sec?.rooms?.[0];
    return{sec,room,rows:room?.positions||[]};
  }
  function renderMeasurements(sec){
    $("quickMeasures").innerHTML=(sec?.measurements||[]).map(m=>{
      const result=C.measured(m);
      const value=result.error?"⚠ "+result.error:result.value===null?"Menge noch offen":C.number(result.value)+" "+m.unit;
      const units=["m²","m","Stk","Std","PA"].map(u=>'<option value="'+C.esc(u)+'"'+(u===m.unit?" selected":"")+'>'+C.esc(u)+'</option>').join("");
      return '<div class="qm-card" data-measure-id="'+C.esc(m.id)+'">'+
        '<label class="qm-card-title">Bauteil / Aufmaß <input aria-label="Aufmaßbezeichnung" data-measure-label="'+C.esc(m.id)+'" value="'+C.esc(m.label||"")+'"></label>'+
        '<label class="qm-card-title">Menge / Rechnung <input class="qm-input" aria-label="Aufmaßformel" data-measure-formula="'+C.esc(m.id)+'" value="'+C.esc(m.formula||"")+'" placeholder="z. B. 48,20 oder 4,5 × 2,5"></label>'+
        '<output class="qm-result'+(result.error?" bad":"")+'">'+C.esc(value)+'</output>'+
        '<div class="qm-actions"><select class="qm-units" data-measure-unit="'+C.esc(m.id)+'" aria-label="Aufmaßeinheit">'+units+'</select>'+
        '<button type="button" class="qm-delete" data-remove-measure="'+C.esc(m.id)+'">Entfernen</button></div></div>';
    }).join("")||'<div class="qm-card">Noch kein Aufmaß. Über „+ Aufmaßzeile“ kannst du beginnen.</div>';
  }
  function renderPositionRow(sec,p){
    const out=C.positionQuantity(sec,p),qty=out.value;
    const missingQty=qty<=0||!!out.error,missingPrice=!(Number(p.unitPrice)>0);
    const sourceOptions=(sec.measurements||[]).filter(m=>m.unit===p.unit).map(m=>
      '<option value="'+C.esc(m.id)+'"'+(p.quantityMode==="linked"&&p.measurementIds?.includes(m.id)?" selected":"")+'>'+C.esc(m.label||"Aufmaß")+'</option>'
    ).join("");
    const selected=missingQty?"<em>Menge prüfen</em>":'<span class="linked-note">'+C.esc(C.number(qty)+" "+p.unit)+'</span>';
    return '<div class="qpos" data-quick-id="'+C.esc(p.id)+'">'+
      '<div><b>'+C.esc(p.text)+'</b><small>'+ (p.quantityMode==="linked"?"🔗 Menge aus Aufmaß":"✎ Manuelle Menge")+
      '</small></div>'+
      '<label class="qfield">Menge<input type="text" inputmode="decimal" class="qpos-qty" data-position-quantity="'+C.esc(p.id)+'" aria-label="Menge für '+C.esc(p.text)+'" value="'+C.esc(qty>0?fmt(qty):"")+'" placeholder="0,00">'+
      '<select class="qlinkselect" data-position-source="'+C.esc(p.id)+'" aria-label="Mengenquelle"><option value="">manuell</option>'+sourceOptions+'</select>'+
      selected+'</label>'+
      '<label class="qfield">EP € netto<input type="text" inputmode="decimal" class="qpos-price" data-position-price="'+C.esc(p.id)+'" aria-label="Einzelpreis netto für '+C.esc(p.text)+'" value="'+C.esc(p.unitPrice>0?fmt(p.unitPrice):"")+'" placeholder="Preis">'+
      (missingPrice?'<em>Preis prüfen</em>':'<small class="linked-note">je '+C.esc(p.unit)+'</small>')+'</label>'+
      '<strong class="value">'+(missingQty||missingPrice?"—":C.esc(money(qty*p.unitPrice)))+'</strong>'+
      '<button type="button" class="qremove" title="Diese Position löschen" aria-label="Position löschen">×</button></div>';
  }
  function render(){
    if(!offer)return;
    const {sec,room,rows}=current(),summary=C.totals(offer);
    const missingQty=rows.filter(p=>{const q=C.positionQuantity(sec,p);return q.value<=0||!!q.error}).length;
    const missingPrice=rows.filter(p=>!(Number(p.unitPrice)>0)).length;
    $("quickResult").hidden=false;
    $("quickCount").textContent=rows.length+" Positionen";
    $("quickCheck").textContent=(summary.errors.length?summary.errors.length+" Aufmaßfehler · ":"")+missingQty+" Mengen, "+missingPrice+" Preise offen";
    $("quickNet").textContent=summary.errors.length?"Aufmaß prüfen":C.currency(summary.net)+" netto · "+(missingQty||missingPrice?"Teilbetrag":"berechnet");
    renderMeasurements(sec);
    $("quickPositions").innerHTML=rows.length?rows.map(p=>renderPositionRow(sec,p)).join(""):
      '<p>Noch keine Positionen. Unten kannst du eine Position aus dem Katalog hinzufügen.</p>';
    try{$("quickPrint").innerHTML=C.printMarkup(offer)}
    catch(e){$("quickPrint").textContent="Druckvorschau wartet auf gültiges Aufmaß: "+e.message}
  }
  function generate(){
    try{
      const result=Q.build({customer:$("quickCustomer").value,title:$("quickTitle").value,
        brief:$("quickBrief").value,preset});
      offer=result.offer;render();
      message("Entwurf erstellt: "+result.positions.length+" Positionen. Aufmaß und Preise kannst du hier direkt ändern.");
      $("quickResult").scrollIntoView({behavior:"smooth",block:"start"});
    }catch(e){message(e.message,true)}
  }
  function findPosition(id){
    const {room}=current();return room?.positions.find(p=>p.id===id)||null;
  }
  function findMeasure(id){
    const {sec}=current();return sec?.measurements.find(m=>m.id===id)||null;
  }
  function validMoney(input,label){
    const raw=input.value.trim();
    const number=raw?Q.num(raw):0;
    if(number===null){message(label+" ist ungültig. Bitte eine nichtnegative Zahl eingeben, z. B. 22,50.",true);input.setCustomValidity("Ungültige Zahl");input.reportValidity();return null}
    input.setCustomValidity("");
    return number;
  }
  function onQuickChange(input){
    if(!offer)return;
    const measureId=input.dataset.measureLabel||input.dataset.measureFormula||input.dataset.measureUnit;
    if(measureId){
      const m=findMeasure(measureId);
      if(!m)return;
      if(input.dataset.measureLabel)m.label=input.value.trim().slice(0,250)||"Aufmaß";
      else if(input.dataset.measureFormula)m.formula=input.value.trim().slice(0,400);
      else if(input.dataset.measureUnit)m.unit=input.value;
      render();
      message("Aufmaß geändert. Verknüpfte Positionsmengen und Ausdruck wurden neu berechnet.");
      return;
    }
    const posId=input.dataset.positionQuantity||input.dataset.positionPrice||input.dataset.positionSource;
    if(!posId)return;
    const p=findPosition(posId);
    if(!p)return;
    if(input.dataset.positionQuantity){
      const number=validMoney(input,"Die Menge");if(number===null)return;
      p.quantityMode="manual";p.quantity=number; // deliberate override, never change another position
      message("Menge manuell geändert. Die Aufmaßverknüpfung kannst du daneben wieder auswählen.");
    }else if(input.dataset.positionPrice){
      const number=validMoney(input,"Der Einzelpreis");if(number===null)return;
      p.unitPrice=number;
      message("Einzelpreis angepasst. Die Angebotssumme und der Ausdruck wurden aktualisiert.");
    }else if(input.dataset.positionSource){
      const previous=C.positionQuantity(offer.sections[0],p).value;
      if(input.value){
        const m=findMeasure(input.value);
        if(!m||m.unit!==p.unit){message("Aufmaß und Position haben unterschiedliche Einheiten.",true);render();return}
        p.quantityMode="linked";p.measurementIds=[m.id];
        message("Menge wieder mit Aufmaß „"+m.label+"“ verknüpft.");
      }else{
        p.quantityMode="manual";p.quantity=previous;
        message("Menge vom Aufmaß gelöst. Der bisherige Wert bleibt erhalten.");
      }
    }
    render();
  }
  function exportFile(){
    if(!offer)return;
    const content=JSON.stringify(offer,null,2),blob=new Blob([content],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="KRISTINE-Angebotsentwurf-TEST.json";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    message("TEST-Entwurf als JSON gespeichert. Keine Übertragung an die Live-Kristine.");
  }
  function handoff(){
    if(!offer)return;
    try{
      const old=localStorage.getItem(KEY);
      if(old&&!confirm("Im V2-Angebotsstudio ist bereits ein TEST-Entwurf gespeichert. Diesen durch den neuen Schnellstart-Entwurf ersetzen? Den bisherigen kannst du vorher im Studio als JSON sichern."))return;
      localStorage.setItem(KEY,JSON.stringify(offer));
      location.href="/angebot-v2";
    }catch(e){message("Browser-Speicherung nicht möglich. Bitte zunächst „JSON sichern“ verwenden und im Angebotsstudio importieren.",true)}
  }
  function dictate(){
    const Recognizer=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognizer){message("Sprachdiktat wird von deinem Browser nicht angeboten. Bitte den Text direkt eingeben.",true);return}
    const input=new Recognizer();input.lang="de-AT";input.interimResults=false;input.maxAlternatives=1;
    input.onresult=e=>{$("quickBrief").value=($("quickBrief").value.trim()+" "+e.results[0][0].transcript).trim();message("Diktat übernommen – bitte Text und Mengen prüfen.")};
    input.onerror=e=>message("Diktat fehlgeschlagen: "+e.error,true);
    try{input.start();message("Diktat läuft. Der Browser kann eine Mikrofonfreigabe verlangen.")}
    catch(e){message("Diktat konnte nicht gestartet werden.",true)}
  }
  function start(){
    example();
    const catalog=$("quickCatalog");
    catalog.innerHTML=C.catalog.map(item=>'<option value="'+C.esc(item.id)+'">'+C.esc(item.category+" · "+item.text)+'</option>').join("");
    document.querySelectorAll("[data-preset]").forEach(btn=>btn.addEventListener("click",()=>{
      preset=btn.dataset.preset;
      document.querySelectorAll("[data-preset]").forEach(x=>x.classList.toggle("active",x===btn));
    }));
    $("quickExample").onclick=example;
    $("quickGenerate").onclick=generate;
    $("quickOpen").onclick=handoff;
    $("quickExport").onclick=exportFile;
    $("quickDictate").onclick=dictate;
    $("quickAddMeasure").onclick=()=>{
      if(!offer)return;
      const {sec,room}=current();
      const m=C.addMeasurement(offer,sec.id,room.id);
      render();
      $("quickMeasures").querySelector('[data-measure-formula="'+CSS.escape(m.id)+'"]')?.focus();
      message("Neue Aufmaßzeile angelegt. Formel oder Menge eingeben.");
    };
    $("quickAddPosition").onclick=()=>{
      if(!offer)return;
      const {sec,room}=current(),key=catalog.value,p=C.addPosition(offer,sec.id,room.id,key);
      if(!p)return;
      const basis=Q.BASIS?.[key],label=Q.MEASURES?.find(x=>x.key===basis)?.label;
      const match=sec.measurements.find(m=>m.label===label&&m.unit===p.unit);
      if(match){p.quantityMode="linked";p.measurementIds=[match.id]}
      else{p.quantityMode="manual";p.quantity=0}
      render();message("Einzelposition hinzugefügt. Menge und Preis prüfen.");
      $("quickPositions").querySelector('[data-position-price="'+CSS.escape(p.id)+'"]')?.focus();
    };
    $("quickResult").addEventListener("change",e=>{
      const input=e.target.closest("[data-measure-label],[data-measure-formula],[data-measure-unit],[data-position-quantity],[data-position-price],[data-position-source]");
      if(input)onQuickChange(input);
    });
    $("quickResult").addEventListener("click",e=>{
      const row=e.target.closest(".qpos[data-quick-id]"),button=e.target.closest("button.qremove");
      if(row&&button&&offer){
        const {sec,room}=current();
        if(C.removePosition(offer,sec.id,room.id,row.dataset.quickId)){
          render();message("Position entfernt. Die übrigen Positionen bleiben unverändert.");
        }
        return;
      }
      const remove=e.target.closest("button[data-remove-measure]");
      if(remove&&offer){
        const {sec}=current(),id=remove.dataset.removeMeasure,measure=findMeasure(id);
        if(!measure)return;
        const linked=sec.rooms.flatMap(r=>r.positions).filter(p=>p.quantityMode==="linked"&&p.measurementIds?.includes(id));
        if(linked.length&&!confirm("Dieses Aufmaß versorgt "+linked.length+" Position(en). Beim Entfernen werden deren aktuelle Mengen zu manuellen Mengen. Aufmaß trotzdem entfernen?"))return;
        for(const p of linked){
          const qty=C.positionQuantity(sec,p);p.quantityMode="manual";p.quantity=qty.error?0:qty.value;p.measurementIds=[];
        }
        sec.measurements=sec.measurements.filter(m=>m.id!==id);
        render();message("Aufmaß entfernt. Verknüpfte Positionen behalten ihre bisherigen Mengen manuell.");
      }
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();

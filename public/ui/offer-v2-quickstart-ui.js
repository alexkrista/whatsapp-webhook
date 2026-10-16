"use strict";
(function(){
  const C=window.KristaOfferV2,Q=window.KristaOfferV2Quick;
  if(!C||!Q)throw Error("KRISTINE Angebots-V2-Kern nicht erreichbar");
  const $=id=>document.getElementById(id),KEY="krista.angebot-v2.isolated-preview.v1";
  let preset="innen",offer=null,created=null;
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
  function updateTotalsAndPreview(){
    if(!offer)return;
    const sec=offer.sections[0],room=sec?.rooms?.[0],rows=room?.positions||[],summary=C.totals(offer);
    const pending=rows.filter(p=>{
      const qty=C.positionQuantity(sec,p);
      return qty.value<=0||!!qty.error||!(Number(p.unitPrice)>0);
    });
    $("quickCount").textContent=rows.length+" Positionen";
    $("quickCheck").textContent=pending.length+" Mengen/Preise offen";
    $("quickNet").textContent=C.currency(summary.net)+" netto · ungeprüfter Teilbetrag";
    for(const m of sec.measurements){
      const result=C.measured(m),field=$("quickMeasurements").querySelector('[data-quick-measure-result="'+m.id+'"]');
      if(field)field.textContent=result.error?"⚠ Formel prüfen":result.value===null?"Noch offen":C.number(result.value)+" "+m.unit;
    }
    for(const p of rows){
      const row=[...$("quickPositions").querySelectorAll(".qpos[data-quick-id]")].find(x=>x.dataset.quickId===p.id);
      if(!row)continue;
      const value=C.positionQuantity(sec,p),q=value.value,qty=row.querySelector("[data-quick-qty]");
      if(qty&&qty!==document.activeElement)qty.value=q>0?String(q).replace(".",","):"";
      const source=row.querySelector("[data-quick-qty-source]");
      if(source)source.textContent=p.quantityMode==="linked"?"↳ aus Aufmaß":"Eigene Menge";
      const total=row.querySelector("[data-quick-total]");
      if(total)total.textContent=q>0&&Number(p.unitPrice)>0&&!value.error?C.currency(q*p.unitPrice):"—";
      const priceSource=row.querySelector("[data-quick-price-source]");
      if(priceSource)priceSource.textContent=Number(p.unitPrice)<=0?"⚠ Preis fehlt":p.priceOrigin==="manual"?"✓ manuell geändert":"Musterpreis · prüfen";
    }
    try{$("quickPrint").innerHTML=C.printMarkup(offer)}
    catch(error){$("quickPrint").textContent="Druckvorschau wartet auf gültiges Aufmaß: "+error.message}
  }
  function render(){
    if(!offer)return;
    const sec=offer.sections[0],room=sec?.rooms?.[0],rows=room?.positions||[];
    $("quickResult").hidden=false;
    $("quickMeasurements").innerHTML=sec.measurements.length
      ?sec.measurements.map(m=>{
        const value=C.measured(m);
        return '<label class="qmeasure" data-quick-measure-row="'+C.esc(m.id)+'">'+
          '<strong>'+C.esc(m.label)+'</strong><input data-quick-measure="'+C.esc(m.id)+'" aria-label="Aufmaßformel '+C.esc(m.label)+'" inputmode="text" value="'+C.esc(m.formula||"")+'" placeholder="z. B. 4,67 × 2,37">'+
          '<small>'+C.esc(m.unit)+'</small><output data-quick-measure-result="'+C.esc(m.id)+'">'+(value.error?"⚠ Formel prüfen":value.value===null?"Noch offen":C.number(value.value)+" "+C.esc(m.unit))+'</output></label>';
      }).join("")
      :'<p class="qmeasure-empty">Noch kein Aufmaß erkannt. Du kannst Mengen unten direkt eingeben oder das detaillierte Aufmaß im Angebotseditor ergänzen.</p>';
    $("quickPositions").innerHTML=rows.length?rows.map(p=>{
      const result=C.positionQuantity(sec,p),q=result.value;
      return '<div class="qpos" data-quick-id="'+C.esc(p.id)+'">'+
        '<div class="qpos-name"><b>'+C.esc(p.text)+'</b><small>'+C.esc(p.unit)+'</small></div>'+
        '<label class="qpos-input">Menge<input data-quick-qty="'+C.esc(p.id)+'" inputmode="decimal" aria-label="Menge '+C.esc(p.text)+'" value="'+C.esc(q>0?String(q).replace(".",","):"")+'" placeholder="Menge">'+
        '<small data-quick-qty-source>'+(p.quantityMode==="linked"?"↳ aus Aufmaß":"Eigene Menge")+'</small></label>'+
        '<label class="qpos-input">€/Einheit<input data-quick-rate="'+C.esc(p.id)+'" inputmode="decimal" aria-label="Einheitspreis '+C.esc(p.text)+'" value="'+C.esc(Number(p.unitPrice)>0?String(p.unitPrice).replace(".",","):"")+'" placeholder="Preis">'+
        '<small data-quick-price-source>'+(Number(p.unitPrice)<=0?"⚠ Preis fehlt":p.priceOrigin==="manual"?"✓ manuell geändert":"Musterpreis · prüfen")+'</small></label>'+
        '<strong class="qpos-total" data-quick-total>'+(q>0&&Number(p.unitPrice)>0&&!result.error?C.currency(q*p.unitPrice):"—")+'</strong>'+
        '<button type="button" class="qremove" aria-label="Position '+C.esc(p.text)+' löschen" title="Diese Position löschen">×</button></div>';
    }).join(""):'<p>Noch keine Positionen. Im Detail-Editor kannst du einzelne Leistungen hinzufügen.</p>';
    updateTotalsAndPreview();
  }
  function changeQuickField(target){
    if(!offer)return;
    const sec=offer.sections[0],room=sec.rooms[0];
    if(target.matches("[data-quick-measure]")){
      const measure=sec.measurements.find(m=>m.id===target.dataset.quickMeasure);
      if(measure)measure.formula=target.value;
      updateTotalsAndPreview();return;
    }
    const pid=target.dataset.quickQty||target.dataset.quickRate;
    if(!pid)return;
    const p=room.positions.find(x=>x.id===pid);
    if(!p)return;
    const value=Q.num(target.value);
    if(target.matches("[data-quick-qty]")){
      // Editing a linked amount is an explicit manual override;
      // all other positions continue to follow the shared takeoff.
      p.quantityMode="manual";p.measurementIds=[];p.quantity=value===null?0:value;
    }else{
      p.unitPrice=value===null?0:value;
      p.priceOrigin="manual";
    }
    updateTotalsAndPreview();
  }
  function generate(){
    try{
      created=Q.build({customer:$("quickCustomer").value,title:$("quickTitle").value,
        brief:$("quickBrief").value,preset});
      offer=created.offer;render();
      message("Entwurf erstellt. "+created.positions.length+" Positionen, "+created.missingQuantity+" Mengen und "+created.missingPrice+" Preise offen. Das ist noch kein fertiges Kundenangebot.");
      $("quickResult").scrollIntoView({behavior:"smooth",block:"start"});
    }catch(e){message(e.message,true)}
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
    document.querySelectorAll("[data-preset]").forEach(btn=>btn.addEventListener("click",()=>{
      preset=btn.dataset.preset;
      document.querySelectorAll("[data-preset]").forEach(x=>x.classList.toggle("active",x===btn));
    }));
    $("quickExample").onclick=example;
    $("quickGenerate").onclick=generate;
    $("quickOpen").onclick=handoff;
    $("quickExport").onclick=exportFile;
    $("quickDictate").onclick=dictate;
    $("quickMeasurements").addEventListener("input",e=>changeQuickField(e.target));
    $("quickPositions").addEventListener("input",e=>changeQuickField(e.target));
    $("quickPositions").addEventListener("change",e=>{
      if(e.target.matches("[data-quick-qty],[data-quick-rate]"))render();
    });
    $("quickMeasurements").addEventListener("change",e=>{
      if(e.target.matches("[data-quick-measure]"))render();
    });
    $("quickPositions").addEventListener("click",e=>{
      const row=e.target.closest(".qpos[data-quick-id]"),button=e.target.closest("button.qremove");
      if(!row||!button||!offer)return;
      const sec=offer.sections[0],room=sec.rooms[0];
      if(C.removePosition(offer,sec.id,room.id,row.dataset.quickId)){
        render();
        message("Position entfernt. Die übrigen Positionen bleiben unverändert.");
      }
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();

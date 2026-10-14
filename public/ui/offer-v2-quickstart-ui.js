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
  function render(){
    if(!offer)return;
    const sec=offer.sections[0],room=sec?.rooms?.[0];
    const rows=room?.positions||[],summary=C.totals(offer);
    const pending=rows.filter(p=>{const qty=C.positionQuantity(sec,p);return qty.value<=0||!!qty.error||!(Number(p.unitPrice)>0)});
    $("quickResult").hidden=false;
    $("quickCount").textContent=rows.length+" Positionen";
    $("quickCheck").textContent=pending.length+" Mengen/Preise offen";
    $("quickNet").textContent=C.currency(summary.net)+" netto · Teilbetrag";
    $("quickPositions").innerHTML=rows.length?rows.map(p=>{
      const value=C.positionQuantity(sec,p),qty=value.value,missingQty=qty<=0||!!value.error,missingPrice=!(Number(p.unitPrice)>0);
      return '<div class="qpos" data-quick-id="'+C.esc(p.id)+'"><div><b>'+C.esc(p.text)+'</b><small>'+(missingQty?'<span class="warn">Menge prüfen</span>':C.esc(C.number(qty)+" "+p.unit))+'</small></div>'+
        '<span class="value">'+(missingPrice?'<span class="warn">Preis prüfen</span>':C.esc(C.currency(p.unitPrice))+" / "+C.esc(p.unit))+'</span>'+
        '<span class="value">'+(missingQty||missingPrice?"—":C.esc(C.currency(qty*p.unitPrice)))+'</span>'+
        '<button type="button" class="qremove" title="Diese Position löschen">×</button></div>';
    }).join(""):'<p>Noch keine Positionen. Im Detail-Editor kannst du einzelne Leistungen hinzufügen.</p>';
    try{$("quickPrint").innerHTML=C.printMarkup(offer)}
    catch(e){$("quickPrint").textContent="Druckvorschau wartet auf gültiges Aufmaß: "+e.message}
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

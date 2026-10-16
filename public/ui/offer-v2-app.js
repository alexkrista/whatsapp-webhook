"use strict";
(function(){
  const C=window.KristaOfferV2;
  if(!C)throw Error("KRISTINE Angebot V2 Kern fehlt");
  const KEY="krista.angebot-v2.isolated-preview.v1";
  const $=id=>document.getElementById(id);
  const e=C.esc;
  let offer=null,history=[],future=[],saveTimer=0,toastTimer=0;let selectedPositions=new Set(),positionClipboard=[];
  const maxHistory=35;
  function toast(msg,bad=false){
    const host=$("toast");host.textContent=String(msg);host.className="toast"+(bad?" warn":"");
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>host.classList.add("hide"),3800);
  }
  function initial(){
    try{
      const saved=localStorage.getItem(KEY);
      if(saved)return C.parseOffer(JSON.parse(saved));
    }catch{}
    return C.sample();
  }
  function autosave(){
    clearTimeout(saveTimer);
    $("saveMark").textContent="Änderungen werden im TEST-Browser gespeichert …";
    saveTimer=setTimeout(()=>{
      try{localStorage.setItem(KEY,JSON.stringify(offer));$("saveMark").textContent="✓ TEST-Entwurf in diesem Browser gespeichert";}catch{
        $("saveMark").textContent="Lokales Speichern gesperrt – bitte JSON exportieren!";
        toast("Browser-Speicherung nicht möglich. JSON exportieren.",true);
      }
    },300);
  }
  function snapshot(){
    history.push(C.copy(offer));
    if(history.length>maxHistory)history.shift();
    future=[];
  }
  function undo(){
    if(!history.length)return toast("Nichts rückgängig zu machen.");
    future.push(C.copy(offer));
    offer=history.pop();all();toast("Letzte Änderung rückgängig.");
  }
  function redo(){
    if(!future.length)return toast("Keine Wiederholung verfügbar.");
    history.push(C.copy(offer));
    offer=future.pop();all();toast("Änderung wiederhergestellt.");
  }
  function downloadJson(){
    const blob=new Blob([JSON.stringify(offer,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="angebot-v2-"+String(offer.number||"test").replace(/[^A-Za-z0-9_-]+/g,"-")+".json";
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);
  }
  function fromFile(file){
    if(!file)return;
    if(file.size>6*1024*1024)return toast("Die JSON-Datei ist zu groß.",true);
    file.text().then(text=>{
      const data=C.parseOffer(JSON.parse(text));
      if(!confirm("Aktuellen TEST-Entwurf durch den importierten Entwurf ersetzen? Ein Rückgängig bleibt möglich."))return;
      snapshot();offer=data;all();toast("Angebot importiert. Alle Positionen und Preise bleiben unabhängig.");
    }).catch(err=>toast("Import fehlgeschlagen: "+err.message,true));
  }
  const catGroups=()=>{
    const list=[];
    for(const p of C.catalog){let group=list.find(x=>x.name===p.category);if(!group){group={name:p.category,items:[]};list.push(group);}group.items.push(p);}
    return list;
  };
  const groups=catGroups();
  const button=(label,action,extra="")=>'<button type="button" data-action="'+e(action)+'" '+extra+' class="action compact">'+e(label)+'</button>';
  const iconButton=(label,action,title)=>'<button class="action secondary compact" type="button" data-action="'+e(action)+'" title="'+e(title||label)+'">'+e(label)+'</button>';
  const del=(action,title)=>'<button type="button" class="action danger compact" data-action="'+e(action)+'" title="'+e(title||"Entfernen")+'" aria-label="'+e(title||"Entfernen")+'">×</button>';
  function catalogSearchKey(value){
    return String(value||"").normalize("NFD").replace(/\p{M}/gu,"").toLocaleLowerCase("de-AT").replace(/ß/g,"ss").replace(/[^a-z0-9]+/g," ").trim();
  }
  function catalogGroups(kind){
    return groups.map(g=>'<details class="catalog-group" data-catalog-group data-catalog-group-name="'+e(g.name)+'"><summary>'+e(g.name)+' <small>'+g.items.length+' Positionen</small></summary><div class="catalog-entries">'+
      g.items.map(p=>kind==="bulk"
        ? '<label class="catalog-check" data-catalog-item data-catalog-text="'+e(p.text+' '+p.unit)+'"><input type="checkbox" data-bulk-check value="'+e(p.id)+'"><span>'+e(p.text)+' <small>'+e(p.unit)+'</small></span></label>'
        : '<button type="button" class="catalog-entry" data-catalog-item data-catalog-text="'+e(p.text+' '+p.unit)+'" data-action="add-pos" data-template-id="'+e(p.id)+'"><span>'+e(p.text)+'</span><small>'+e(p.unit)+' · '+(Number(p.price)>0?'Musterpreis '+C.currency(p.price):'Preis prüfen')+' · +</small></button>'
      ).join("")+'</div></details>').join("");
  }
  function catalogBrowser(kind="single"){
    const bulk=kind==="bulk";
    return '<div class="catalog-browser" data-catalog-browser data-catalog-kind="'+kind+'">'+
      '<label class="catalog-search-label">🔎 Leistung suchen <input type="search" autocomplete="off" data-catalog-search aria-label="Leistungspositionen durchsuchen" placeholder="z. B. spachteln, abdecken, Acryl"></label>'+
      '<div class="catalog-browser-status" data-catalog-status aria-live="polite">'+C.catalog.length+' Positionen in '+groups.length+' Gruppen</div>'+
      '<div class="catalog-browser-groups">'+catalogGroups(kind)+'</div>'+
      '<p class="catalog-empty" data-catalog-empty hidden>Keine Position gefunden. Suche anders oder verwende eine freie Position.</p></div>';
  }
  function filterCatalogBrowser(container,value){
    if(!container)return 0;
    const term=catalogSearchKey(value);
    let count=0;
    for(const group of container.querySelectorAll("[data-catalog-group]")){
      const categoryMatches=term!==""&&catalogSearchKey(group.dataset.catalogGroupName).includes(term);
      let matching=0;
      for(const item of group.querySelectorAll("[data-catalog-item]")){
        const matches=!term||categoryMatches||catalogSearchKey(item.dataset.catalogText).includes(term);
        item.hidden=!matches;
        if(matches)matching++;
      }
      group.hidden=matching===0;
      if(term&&matching>0)group.open=true;
      count+=matching;
    }
    const status=container.querySelector("[data-catalog-status]");
    if(status)status.textContent=term?count+" Treffer":"Alle "+count+" Leistungen in "+groups.length+" Gruppen";
    const empty=container.querySelector("[data-catalog-empty]");
    if(empty)empty.hidden=count!==0;
    return count;
  }
  function offerHeader(){
    const field=(label,key,type="text",attrs="")=>'<label>'+label+'<input type="'+type+'" '+attrs+' data-offer-field="'+key+'" value="'+e(offer[key]??"")+'"></label>';
    return '<section class="editor-card"><h2 class="card-title">1. Angebot und Kunde</h2><div class="form-grid">'+
      field("Projekt / Angebotsbezeichnung","title")+
      field("Angebotsnummer (nur TEST)","number")+
      '<h3 class="wide" style="margin:10px 0 0">Kundenanschrift</h3>'+
      field("Kunde / Firma / Bauherrschaft","customer")+
      field("Ansprechperson","contactName")+
      field("Straße","street")+
      field("Hausnummer","houseNumber")+
      field("PLZ","postalCode")+
      field("Ort","city")+
      field("Land","country")+
      '<p class="subtle wide">Kundenstamm-Verknüpfung vorbereitet. In dieser isolierten Testversion werden die Adressfelder noch manuell bearbeitet.</p>'+
      '<label class="wide">Einleitung<textarea data-offer-field="intro">'+e(offer.intro)+'</textarea></label>'+
      '<h3 class="wide" style="margin:12px 0 0">Termine</h3>'+
      field("Termin vor Ort (intern)","siteVisitDate","date")+
      field("Uhrzeit vor Ort (intern)","siteVisitTime","time")+
      '<label>Ausführungstermin<select data-offer-field="executionMode"><option value="agreement"'+(!offer.executionMode||offer.executionMode==="agreement"?' selected':'')+'>Nach Absprache</option><option value="date"'+(offer.executionMode==="date"?' selected':'')+'>Fixes Datum</option><option value="period"'+(offer.executionMode==="period"?' selected':'')+'>Zeitraum</option></select></label>'+
      (offer.executionMode==="date"?field("Ausführung am","executionDate","date"):offer.executionMode==="period"?field("Ausführung von","executionStart","date")+field("Ausführung bis","executionEnd","date"):"")+
      '<h3 class="wide" style="margin:12px 0 0">Konditionen</h3>'+
      field("Gesamtrabatt %","discountPercent","number",'min="0" max="100" step="0.1"')+
      field("MwSt. %","vatRate","number",'min="0" max="100" step="0.1"')+
      field("Skonto %","cashDiscountPercent","number",'min="0" max="100" step="0.1"')+
      field("Skonto innerhalb von (Tagen)","cashDiscountDays","number",'min="0" max="365" step="1"')+
      field("Zahlungsziel netto (Tage)","netPaymentDays","number",'min="0" max="365" step="1"')+
      field("Vorauskassa / Anzahlung % vom Auftrag","advancePercent","number",'min="0" max="100" step="0.1"')+
      field("Skonto auf Vorauskassa %","advanceDiscountPercent","number",'min="0" max="100" step="0.1"')+
      '<p class="subtle wide">Zahlungsbedingungen werden im TEST-Entwurf gespeichert; Übernahme in die Kundenmappe und Belegprüfung folgen mit der Stammdatenanbindung.</p>'+
      '</div></section>';
  }
    function sectionMeasurements(sec){
    const head='<div class="measure-grid measure-head"><span>Raum / Bauteil</span><span>Aufmaß / Rechnung</span><span>Einheit</span><span>Menge</span><span>Ergebnis</span><span></span></div>';
    const lines=sec.measurements.map(m=>{
      const computed=C.measured(m);
      const val=computed.error?'<span class="bad" title="'+e(computed.error)+'">Prüfen</span>':computed.value===null?'–':C.number(computed.value);
      return '<div class="measure-grid" data-mid="'+e(m.id)+'">'+
        '<select data-measure-field="roomId" aria-label="Raum / Bauteil"><option value="">Alle Räume</option>'+sec.rooms.map(r=>'<option value="'+e(r.id)+'"'+(r.id===m.roomId?' selected':'')+'>'+e(r.name)+'</option>').join("")+'</select>'+
        '<input data-measure-field="label" aria-label="Aufmaßbezeichnung" value="'+e(m.label)+'" placeholder="z. B. Wandflächen">'+
        '<select data-measure-field="unit" aria-label="Einheit">'+["m²","m","Stk","PA","Std"].map(u=>'<option'+(u===m.unit?' selected':'')+'>'+e(u)+'</option>').join("")+'</select>'+
        '<input data-measure-field="formula" aria-label="Aufmaßformel" title="Rechnung z. B. (4,6 + 3,2) × 2 × 2,5 - 3" value="'+e(m.formula||"")+'" placeholder="4,5×2,5">'+
        '<output class="measure-total" data-measure-result="'+e(m.id)+'">'+val+'</output>'+
        del("remove-measure","Aufmaßzeile entfernen")+'</div>';
    }).join("");
    return '<div class="measurement-panel"><div class="measurement-heading"><div><div class="sheet-label">📐 Aufmaß für den gesamten Abschnitt</div><div class="sheet-note">Eine Aufmaßzeile kann mehreren Positionen zugeordnet werden. Formeln mit Klammern, ×, + und − sind möglich.</div></div>'+button("+ Aufmaßzeile","add-measure")+'</div>'+
      head+(lines||'<div class="empty-note">Noch keine Aufmaßzeile. Du kannst Positionen trotzdem mit freier Menge erfassen.</div>')+'</div>';
  }
  function measurementChoices(sec,p){
    const matching=sec.measurements.filter(m=>m.unit===p.unit);
    if(!matching.length)return '<span class="muted">Keine Aufmaßzeile mit Einheit '+e(p.unit)+'. Bitte oben eine anlegen.</span>';
    return '<div class="source-checklist">'+matching.map(m=>'<label><input type="checkbox" data-p-source value="'+e(m.id)+'"'+((p.measurementIds||[]).includes(m.id)?' checked':'')+'> '+e(m.label)+' <small>('+e(m.unit)+')</small></label>').join("")+'</div>';
  }
  function positionRow(sec,r,p,index,summary){
    const q=summary.positions[index];
    const linked=p.quantityMode==="linked";
    const chosen=(p.measurementIds||[])[0]||"";
    const allSources=(p.measurementIds||[]).length;
    return '<div class="position-card'+(p.alternative?' alternative':'')+'" data-pid="'+e(p.id)+'">'+
      '<div class="position-top">'+
      '<label title="Position markieren"><input type="checkbox" data-multi-mark="'+e(p.id)+'"'+(selectedPositions.has(p.id)?' checked':'')+'></label><span class="number">'+(index+1)+'.</span>'+
      '<input class="position-title" data-p-field="text" aria-label="Leistungsbeschreibung" value="'+e(p.text)+'">'+
      '<input type="number" min="0" step="0.01" data-p-field="quantity" aria-label="Menge" value="'+e(linked?q.quantity:p.quantity)+'"'+(linked?' readonly title="Menge aus Aufmaß"':'')+'>'+
      '<input data-p-field="unit" aria-label="Einheit" value="'+e(p.unit)+'">'+
      '<input data-p-field="unitPrice" type="number" min="0" step=".01" aria-label="Einheitspreis" value="'+e(p.unitPrice)+'">'+
      '<output class="position-amount" data-position-result="'+e(p.id)+'">'+(q.alternative?'Alternative':C.currency(q.net))+'</output>'+
      del("remove-pos","Leistungsposition einzeln löschen")+'</div>'+
      '<div class="position-bottom">'+
      '<label>Menge <select data-p-field="quantityMode"><option value="manual"'+(!linked?' selected':'')+'>frei</option><option value="linked"'+(linked?' selected':'')+'>aus Aufmaß</option></select></label>'+
      (linked?'<div class="source-choices"><strong>Aufmaß:</strong> '+measurementChoices(sec,p)+'</div>':'')+
      '<label><input type="checkbox" data-p-field="alternative"'+(p.alternative?' checked':'')+'> Alternative Position</label>'+
      '<span class="position-price-origin">'+(p.priceOrigin==="manual"?"✓ Preis manuell geändert":"Musterpreis aus Testkatalog · vor Versand prüfen")+'</span>'+
      iconButton("⧉","duplicate-pos","Position kopieren")+
      iconButton("↑","move-pos-up","Position nach oben")+
      iconButton("↓","move-pos-down","Position nach unten")+
      (linked&&allSources>1?'<small class="muted">Mehrere Aufmaße zugeordnet – nach Bearbeiten wird die Auswahl vereinfacht</small>':'')+
      (q.error?'<span class="bad" title="'+e(q.error)+'">⚠ '+e(q.error)+'</span>':'')+
      '</div></div>';
  }
  function roomCard(sec,r,i,summary){
    return '<article class="room-card" data-rid="'+e(r.id)+'">'+
      '<div class="room-head"><span class="sheet-label">▤ '+(i+1)+'.</span><input data-room-field="name" aria-label="Raum-/Bauteilname" value="'+e(r.name)+'">'+
      '<strong class="room-total" data-room-total="'+e(r.id)+'">'+C.currency(summary.total)+'</strong>'+
      iconButton("↑","move-room-up","Raum nach oben")+iconButton("↓","move-room-down","Raum nach unten")+
      del("remove-room","Raum / Bauteil mit Positionen löschen")+
      '<button type="button" class="action compact secondary" data-action="collapse-room" aria-expanded="true">Schließen ▴</button></div>'+
      '<div class="room-body">'+
      '<label class="edit-field room-description">Beschreibung dieses Raums (wird gedruckt)<textarea data-room-field="description">'+e(r.description||"")+'</textarea></label>'+
      '<div class="position-table">'+(r.positions.length?'<div class="position-columns"><span>Auswahl</span><span>Pos.</span><span>Leistungsbeschreibung</span><span>Menge</span><span>Einheit</span><span>Einzelpreis €</span><span>Gesamt €</span><span></span></div>':'')+(r.positions.map((p,j)=>positionRow(sec,r,p,j,summary)).join("")||'<div class="empty-note">Noch keine Position. Einzelne Leistung oder Paket auswählen.</div>')+'</div>'+
      '<div class="position-controls"><div class="catalog-panel-head"><strong>+ Leistungsposition einzeln hinzufügen</strong><span class="muted">Nach Gruppen aufklappbar und suchbar · aktuell Testkatalog, nicht der WinWorker-Firmenstamm</span></div>'+catalogBrowser()+
      '<div class="position-add"><button type="button" class="action secondary compact" data-action="add-pos" data-template-id="free">+ Freie Position</button><span class="muted">Jede gewählte Position ist unabhängig bearbeitbar und löschbar. Preise hier sind Musterwerte.</span></div></div>'+
      '<details class="bulk-panel"><summary>+ Leistungspaket gesammelt auswählen</summary><p class="sheet-note">Mehrere einzelne Positionen anhaken. Auch bei der Sammelauswahl bleibt jede Position einzeln löschbar.</p>'+
      catalogBrowser("bulk")+'<button type="button" class="action solid" data-action="bulk-add">✓ Markierte Positionen hinzufügen</button></details>'+
      '</div></article>';
  }
  function sectionCard(sec,index,summary){
    return '<section class="section-card" data-sid="'+e(sec.id)+'">'+
      '<div class="section-title"><div class="button-row"><span class="section-drag" draggable="true" title="Abschnitt ziehen und verschieben" aria-label="Abschnitt verschieben" role="button">⠿</span><span class="section-index">'+(index+1)+'. Abschnitt</span><label><input data-section-field="name" value="'+e(sec.name)+'" aria-label="Abschnittsname"></label></div>'+
      '<div class="section-action">'+iconButton("↑","move-section-up","Abschnitt nach oben")+iconButton("↓","move-section-down","Abschnitt nach unten")+
      '<strong data-section-total="'+e(sec.id)+'">'+C.currency(summary.total)+'</strong>'+
      '<button type="button" class="action secondary compact" data-action="collapse-section" aria-expanded="true">Schließen ▴</button>'+
      del("remove-section","Gesamten Abschnitt entfernen")+'</div></div>'+
      '<div class="section-body">'+
      '<div class="section-tools"><div class="sheet-note">Pro Abschnitt ein Aufmaß. Jeder Raum / jedes Bauteil kann darauf zugreifen.</div>'+
      button("+ Raum / Bauteil","add-room")+'</div>'+
      sectionMeasurements(sec)+
      '<div class="rooms-stack">'+sec.rooms.map((r,i)=>roomCard(sec,r,i,summary.rooms[i])).join("")+'</div>'+
      '</div></section>';
  }
  function captureCatalogUi(){
    const state=new Map();
    for(const panel of $("editor").querySelectorAll("[data-catalog-browser]")){
      const room=panel.closest(".room-card"),section=panel.closest(".section-card");
      if(!room||!section)continue;
      state.set(section.dataset.sid+":"+room.dataset.rid+":"+panel.dataset.catalogKind,{
        search:panel.querySelector("[data-catalog-search]")?.value||"",
        open:[...panel.querySelectorAll("[data-catalog-group]")].filter(g=>g.open).map(g=>g.dataset.catalogGroupName),
        checked:[...panel.querySelectorAll("[data-bulk-check]:checked")].map(x=>x.value)
      });
    }
    return state;
  }
  function restoreCatalogUi(state){
    for(const panel of $("editor").querySelectorAll("[data-catalog-browser]")){
      const room=panel.closest(".room-card"),section=panel.closest(".section-card");
      if(!room||!section)continue;
      const previous=state.get(section.dataset.sid+":"+room.dataset.rid+":"+panel.dataset.catalogKind);
      if(!previous)continue;
      const search=panel.querySelector("[data-catalog-search]");
      if(search)search.value=previous.search;
      filterCatalogBrowser(panel,previous.search);
      for(const group of panel.querySelectorAll("[data-catalog-group]")){
        if(!previous.search)group.open=previous.open.includes(group.dataset.catalogGroupName);
      }
      for(const checked of panel.querySelectorAll("[data-bulk-check]")){
        checked.checked=previous.checked.includes(checked.value);
      }
    }
  }
  function renderEditor(){
    const beforeCatalog=captureCatalogUi();
    // Der Neuaufbau darf keine vom Benutzer geschlossenen Räume/Abschnitte öffnen.
    const collapsedSections=new Set([...$("editor").querySelectorAll(".section-card")].filter(el=>el.querySelector(".section-body")?.classList.contains("hide")).map(el=>el.dataset.sid));
    const collapsedRooms=new Set([...$("editor").querySelectorAll(".room-card")].filter(el=>el.querySelector(".room-body")?.classList.contains("hide")).map(el=>el.dataset.rid));
    const scrollY=window.scrollY;
    const anchor=document.activeElement?.closest?.(".room-card,.section-card");
    const anchorKind=anchor?.classList.contains("room-card")?"room":"section";
    const anchorId=anchor?.dataset[anchorKind==="room"?"rid":"sid"];
    const anchorTop=anchor?.getBoundingClientRect().top;
    const calc=C.totals(offer);
    $("editor").innerHTML=offerHeader()+
      '<div class="button-row" style="justify-content:space-between;margin:4px 0 14px"><h2 style="margin:0">2. Abschnitte · Räume · Positionen</h2><span class="status-mark">'+offer.sections.length+' Abschnitte</span></div>'+
      '<div class="editor-card" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><label><input type="checkbox" data-multi-all> Alle Positionen markieren</label><strong>'+selectedPositions.size+' gewählt</strong><button type="button" class="action compact" data-action="multi-copy">⧉ Kopieren</button><button type="button" class="action compact secondary" data-action="multi-paste">Einfügen</button><button type="button" class="action compact secondary" data-action="multi-move">Verschieben</button><button type="button" class="action compact danger" data-action="multi-delete">Löschen</button><label>Ziel <select data-multi-target>'+offer.sections.flatMap(sec=>sec.rooms.map(r=>'<option value="'+e(sec.id)+'|'+e(r.id)+'">'+e(sec.name)+' / '+e(r.name)+'</option>')).join("")+'</select></label></div>'+
      offer.sections.map((sec,i)=>sectionCard(sec,i,calc.sections[i])).join("")+
      '<div class="editor-card"><strong>Weiteren Abschnitt anlegen</strong><p class="subtle">Was soll KRISTINE aus dem letzten Abschnitt übernehmen?</p><div class="button-row">'+
      '<button type="button" class="action" data-action="new-section" data-new-mode="copy">Gleiches Aufmaß übernehmen</button>'+
      '<button type="button" class="action" data-action="new-section" data-new-mode="extend">Aufmaß übernehmen + ergänzen</button>'+
      '<button type="button" class="action solid" data-action="new-section" data-new-mode="new">Ganz neuer Abschnitt</button></div></div>';
    restoreCatalogUi(beforeCatalog);
    for(const el of $("editor").querySelectorAll(".section-card")){
      if(!collapsedSections.has(el.dataset.sid))continue;
      el.querySelector(".section-body")?.classList.add("hide");
      const btn=el.querySelector('[data-action="collapse-section"]');
      if(btn){btn.textContent="Öffnen ▾";btn.setAttribute("aria-expanded","false");}
    }
    for(const el of $("editor").querySelectorAll(".room-card")){
      if(!collapsedRooms.has(el.dataset.rid))continue;
      el.querySelector(".room-body")?.classList.add("hide");
      const btn=el.querySelector('[data-action="collapse-room"]');
      if(btn){btn.textContent="Öffnen ▾";btn.setAttribute("aria-expanded","false");}
    }
    // Nach Einfügen/Kopieren am bisherigen Raum bleiben, statt an den Seitenanfang zu springen.
    if(anchorId&&Number.isFinite(anchorTop)){
      const match=[...$("editor").querySelectorAll(anchorKind==="room"?".room-card":".section-card")]
        .find(el=>el.dataset[anchorKind==="room"?"rid":"sid"]===anchorId);
      if(match)window.scrollBy(0,match.getBoundingClientRect().top-anchorTop);
      else window.scrollTo(0,scrollY);
    }else window.scrollTo(0,scrollY);
    $("summaryTotal").textContent=C.currency(calc.gross);
    $("undoBtn").disabled=!history.length;$("redoBtn").disabled=!future.length;
  }
  function updatePreview(){
    const calc=C.totals(offer);
    $("summaryTotal").textContent=C.currency(calc.gross);
    const holder=$("printPreview"),issues=$("printErrors"),printBtn=$("printBtn");
    if(calc.errors.length){
      issues.classList.remove("hide");
      issues.textContent="Vor der Ausgabe bitte prüfen: "+calc.errors.join(" · ");
      printBtn.disabled=true;holder.innerHTML='<p class="preview-errors">Der Ausdruck wird erst freigegeben, wenn alle Aufmaßformeln stimmen. Deine Eingaben bleiben erhalten.</p>';
    }else{
      issues.classList.add("hide");printBtn.disabled=false;
      try{holder.innerHTML=C.printMarkup(offer)}catch(err){issues.classList.remove("hide");issues.textContent=err.message;printBtn.disabled=true;}
    }
    document.querySelectorAll("[data-measure-result]").forEach(el=>{
      const row=el.closest("[data-mid]"),sec=el.closest("[data-sid]");
      const source=sec&&C.findSection(offer,sec.dataset.sid)?.measurements.find(x=>x.id===row.dataset.mid);
      if(!source)return;const m=C.measured(source);
      el.textContent=m.error?"Prüfen":m.value===null?"–":C.number(m.value);
      el.title=m.error||"";
    });
    document.querySelectorAll("[data-section-total]").forEach(el=>{
      const x=calc.sections.find(s=>s.sectionId===el.dataset.sectionTotal);
      if(x)el.textContent=C.currency(x.total);
    });
    document.querySelectorAll("[data-room-total]").forEach(el=>{
      const value=calc.sections.flatMap(s=>s.rooms).find(r=>r.roomId===el.dataset.roomTotal);
      if(value)el.textContent=C.currency(value.total);
    });
    document.querySelectorAll(".position-card[data-pid]").forEach(row=>{
      const x=calc.sections.flatMap(s=>s.rooms).flatMap(r=>r.positions).find(p=>p.positionId===row.dataset.pid);
      if(!x)return;
      const net=row.querySelector("[data-position-result]");if(net)net.textContent=x.alternative?"Alternative":C.currency(x.net);
      const count=row.querySelector('[data-p-field="quantity"]');if(count&&count.readOnly)count.value=x.quantity;
    });
  }
  function all(){renderEditor();updatePreview();autosave();}
  function findNodes(target){
    const secElement=target.closest("[data-sid]"),roomElement=target.closest("[data-rid]"),measureElement=target.closest("[data-mid]"),positionElement=target.closest("[data-pid]");
    const sec=secElement?C.findSection(offer,secElement.dataset.sid):null;
    const room=sec&&roomElement?C.findRoom(offer,sec.id,roomElement.dataset.rid):null;
    const measure=sec&&measureElement?sec.measurements.find(m=>m.id===measureElement.dataset.mid):null;
    const pos=room&&positionElement?room.positions.find(p=>p.id===positionElement.dataset.pid):null;
    return{sec,room,measure,pos,secElement,roomElement};
  }
  function changeField(target,eventType){
    const n=findNodes(target),key=target.dataset.offerField||target.dataset.sectionField||target.dataset.roomField||target.dataset.measureField||target.dataset.pField;
    if(!key)return;
    const subject=target.dataset.offerField?offer:target.dataset.sectionField?n.sec:target.dataset.roomField?n.room:target.dataset.measureField?n.measure:n.pos;
    if(!subject)return;
    if(key==="measurementIds"){subject.measurementIds=target.value?[target.value]:[];}
    else if(key==="alternative"){subject[key]=target.checked;}
    else if(["unitPrice","quantity","discountPercent","vatRate","cashDiscountPercent","cashDiscountDays","netPaymentDays","advancePercent","advanceDiscountPercent"].includes(key)){subject[key]=Math.max(0,Number(target.value)||0);if(key==="unitPrice")subject.priceOrigin="manual";}
    else if(key==="quantityMode"){subject[key]=target.value==="linked"?"linked":"manual";if(subject.quantityMode==="linked"&&!subject.measurementIds?.length){
      const eligible=n.sec.measurements.find(m=>m.unit===subject.unit&&(m.roomId===""||m.roomId===n.room.id));
      subject.measurementIds=eligible?[eligible.id]:[];
    }}
    else subject[key]=target.value;
    if(key==="unit"&&subject.quantityMode==="linked")subject.measurementIds=[];
    if(["executionMode","quantityMode","measurementIds","alternative"].includes(key)||(key==="unit"&&eventType==="change"))renderEditor();
    updatePreview();autosave();
  }
  function structural(action,target){
    const n=findNodes(target);const s=n.sec,r=n.room,p=n.pos,m=n.measure;
    if(action.startsWith("multi-")){
      const ids=selectedPositions;
      const items=offer.sections.flatMap(sec=>sec.rooms.flatMap(r=>r.positions.filter(p=>ids.has(p.id)).map(p=>({sec,r,p}))));
      const current=document.querySelector("[data-multi-target]")?.value||"";
      const [sid,rid]=current.split("|");const dest=C.findRoom(offer,sid,rid);
      if(action==="multi-copy"){if(!items.length)return toast("Bitte Positionen markieren.");positionClipboard=items.map(x=>({position:C.copy(x.p),sectionId:x.sec.id}));toast(items.length+" Position(en) zum Einfügen kopiert.");return;}
      if(action==="multi-paste"){
        if(!dest||!positionClipboard.length)return toast("Bitte zuerst Positionen kopieren und Ziel wählen.",true);
        snapshot();for(const x of positionClipboard){const p=C.copy(x.position);p.id="pos-copy-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10);if(sid!==x.sectionId&&p.quantityMode==="linked"){p.quantityMode="manual";p.measurementIds=[];}dest.positions.push(p);}
        selectedPositions.clear();all();toast(positionClipboard.length+" Kopien eingefügt.");return;
      }
      if(!items.length)return toast("Bitte Positionen markieren.");
      if(action==="multi-delete"&&!confirm(items.length+" Position(en) löschen? Rückgängig ist möglich."))return;
      if(action==="multi-move"&&!dest)return toast("Bitte Zielraum auswählen.",true);
      snapshot();
      for(const x of items){x.r.positions=x.r.positions.filter(p=>p.id!==x.p.id);if(action==="multi-move"){if(x.sec.id!==sid&&x.p.quantityMode==="linked"){x.p.quantityMode="manual";x.p.measurementIds=[];}dest.positions.push(x.p);}}
      selectedPositions.clear();all();toast(items.length+" Position(en) "+(action==="multi-move"?"verschoben":"gelöscht")+".");return;
    }
    switch(action){
      case "add-measure":snapshot();C.addMeasurement(offer,s.id);break;
      case "remove-measure":{
        if(!m)return;const used=s.rooms.flatMap(x=>x.positions).filter(x=>(x.measurementIds||[]).includes(m.id));
        if(used.length&&!confirm("Dieses Aufmaß ist "+used.length+" Position(en) zugeordnet. Entfernen und Zuordnungen anschließend prüfen?"))return;
        snapshot();s.measurements=s.measurements.filter(x=>x.id!==m.id);break;
      }
      case "add-room":snapshot();C.addRoom(offer,s.id);break;
      case "remove-room":if(!r||!confirm('Raum "'+r.name+'" samt '+r.positions.length+' Position(en) löschen?'))return;snapshot();s.rooms=s.rooms.filter(x=>x.id!==r.id);s.measurements=s.measurements.filter(x=>x.roomId!==r.id);break;
      case "remove-section":if(!s||!confirm('Ganzen Abschnitt "'+s.name+'" löschen?'))return;snapshot();offer.sections=offer.sections.filter(x=>x.id!==s.id);if(!offer.sections.length)offer.sections.push(C.fresh().sections[0]);break;
      case "move-section-up":case "move-section-down":snapshot();C.reorder(offer.sections,s.id,action.endsWith("up")?-1:1);break;
      case "move-room-up":case "move-room-down":snapshot();C.reorder(s.rooms,r.id,action.endsWith("up")?-1:1);break;
      case "add-pos":{
        const template=target.dataset.templateId||"free";
        if(!C.catalog.some(x=>x.id===template))return toast("Unbekannte Leistungsposition.",true);
        snapshot();C.addPosition(offer,s.id,r.id,template);
        toast("Position hinzugefügt – unabhängig bearbeitbar und einzeln löschbar.");break;
      }
      case "bulk-add":{
        const values=[...n.roomElement.querySelectorAll("[data-bulk-check]:checked")].map(x=>x.value);
        if(!values.length)return toast("Bitte mindestens eine Leistung auswählen.");
        snapshot();C.addBulk(offer,s.id,r.id,values);toast(values.length+" Position(en) übernommen. Alle einzeln löschbar.");break;
      }
      case "remove-pos":if(!p)return;snapshot();C.removePosition(offer,s.id,r.id,p.id);toast("Position gelöscht. Über ↶ rückgängig machbar.");break;
      case "duplicate-pos":snapshot();C.duplicatePosition(offer,s.id,r.id,p.id);break;
      case "move-pos-up":case "move-pos-down":snapshot();C.reorder(r.positions,p.id,action.endsWith("up")?-1:1);break;
      case "collapse-room":{
        const body=n.roomElement.querySelector(".room-body");body.classList.toggle("hide");
        target.textContent=body.classList.contains("hide")?"Öffnen ▾":"Schließen ▴";
        target.setAttribute("aria-expanded",String(!body.classList.contains("hide")));return;
      }
      case "collapse-section":{
        const body=n.secElement.querySelector(".section-body");body.classList.toggle("hide");
        target.textContent=body.classList.contains("hide")?"Öffnen ▾":"Schließen ▴";
        target.setAttribute("aria-expanded",String(!body.classList.contains("hide")));return;
      }
      case "new-section":snapshot();C.addSection(offer,target.dataset.newMode||"new");toast("Neuer Abschnitt angelegt. Positionen werden niemals automatisch kopiert.");break;
      default:return;
    }
    all();
  }
  function documentChange(event){
    const t=event.target;
    if(t.matches("[data-multi-mark]")){if(t.checked)selectedPositions.add(t.dataset.multiMark);else selectedPositions.delete(t.dataset.multiMark);renderEditor();return;}
    if(t.matches("[data-multi-all]")){selectedPositions.clear();if(t.checked)offer.sections.forEach(sec=>sec.rooms.forEach(r=>r.positions.forEach(p=>selectedPositions.add(p.id))));renderEditor();return;}
    if(t.matches("[data-catalog-search]")){
      filterCatalogBrowser(t.closest("[data-catalog-browser]"),t.value);
      return;
    }
    if(t.matches("[data-p-source]")){
      const n=findNodes(t);
      if(!n.pos)return;
      n.pos.measurementIds=Array.isArray(n.pos.measurementIds)?n.pos.measurementIds:[];
      if(t.checked&&!n.pos.measurementIds.includes(t.value))n.pos.measurementIds.push(t.value);
      if(!t.checked)n.pos.measurementIds=n.pos.measurementIds.filter(id=>id!==t.value);
      updatePreview();autosave();return;
    }
    if(t.matches("[data-offer-field],[data-section-field],[data-room-field],[data-measure-field],[data-p-field]")){
      changeField(t,event.type);
    }
  }
  function documentClick(event){
    const search=event.target.closest("[data-catalog-search]");
    if(search)return;
    const action=event.target.closest("[data-action]");if(!action)return;
    structural(action.dataset.action,action);
  }
  let draggedSectionId="";
  function sectionDragStart(ev){
    const handle=ev.target.closest(".section-drag");
    if(!handle)return;
    const section=handle.closest(".section-card");
    if(!section||!section.querySelector(".section-body")?.classList.contains("hide")){
      ev.preventDefault();toast("Zum Verschieben bitte den Abschnitt zuerst schließen.");return;
    }
    draggedSectionId=section.dataset.sid;
    ev.dataTransfer.effectAllowed="move";
    ev.dataTransfer.setData("text/plain",draggedSectionId);
    section.classList.add("section-dragging");
  }
  function sectionDragOver(ev){
    const section=ev.target.closest(".section-card");
    if(!draggedSectionId||!section||section.dataset.sid===draggedSectionId)return;
    if(!section.querySelector(".section-body")?.classList.contains("hide"))return;
    ev.preventDefault();ev.dataTransfer.dropEffect="move";
    document.querySelectorAll(".section-drop-target").forEach(n=>n.classList.remove("section-drop-target"));
    section.classList.add("section-drop-target");
  }
  function sectionDrop(ev){
    const target=ev.target.closest(".section-card"),sourceId=draggedSectionId;
    if(!target||!sourceId||target.dataset.sid===sourceId)return;
    if(!target.querySelector(".section-body")?.classList.contains("hide"))return;
    ev.preventDefault();
    const from=offer.sections.findIndex(x=>x.id===sourceId),to=offer.sections.findIndex(x=>x.id===target.dataset.sid);
    if(from<0||to<0)return;
    const rect=target.getBoundingClientRect(),after=ev.clientY>rect.top+rect.height/2;
    snapshot();
    const [moving]=offer.sections.splice(from,1);
    let destination=offer.sections.findIndex(x=>x.id===target.dataset.sid);
    if(after)destination++;
    offer.sections.splice(destination,0,moving);
    draggedSectionId="";
    document.querySelectorAll(".section-drop-target,.section-dragging").forEach(n=>n.classList.remove("section-drop-target","section-dragging"));
    all();toast("Abschnitt verschoben.");
  }
  function sectionDragEnd(){draggedSectionId="";document.querySelectorAll(".section-drop-target,.section-dragging").forEach(n=>n.classList.remove("section-drop-target","section-dragging"));}
  function bind(){
    $("editor").addEventListener("input",documentChange);
    $("editor").addEventListener("change",documentChange);
    $("editor").addEventListener("click",documentClick);
    $("editor").addEventListener("dragstart",sectionDragStart);
    $("editor").addEventListener("dragover",sectionDragOver);
    $("editor").addEventListener("drop",sectionDrop);
    $("editor").addEventListener("dragend",sectionDragEnd);
    $("undoBtn").onclick=undo;$("redoBtn").onclick=redo;
    $("printBtn").onclick=()=>{if(C.totals(offer).errors.length)return toast("Bitte ungültiges Aufmaß korrigieren.",true);window.print();};
    $("exportBtn").onclick=downloadJson;
    $("importBtn").onclick=()=>$("importInput").click();
    $("importInput").onchange=evt=>{fromFile(evt.target.files[0]);evt.target.value="";};
    $("newBtn").onclick=()=>{if(!confirm("Neues leeres TEST-Angebot öffnen? Das bisherige kann über Rückgängig wiederhergestellt werden."))return;snapshot();offer=C.fresh();all();};
    $("wallnerBtn").onclick=()=>{if(!confirm("Den TEST-Fall Wallner laden? Dein aktueller Entwurf kann über Rückgängig wiederhergestellt werden."))return;snapshot();offer=C.sample();all();};
    document.addEventListener("keydown",evt=>{if((evt.ctrlKey||evt.metaKey)&&evt.key.toLowerCase()==="z"&&!evt.target.matches("input,textarea")){evt.preventDefault();undo();}});
  }
  offer=initial();bind();all();
  window.KristaOfferV2Preview={getOffer:()=>C.copy(offer),render:all};
})();

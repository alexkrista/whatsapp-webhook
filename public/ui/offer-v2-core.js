"use strict";
/* KRISTINE Angebot V2: one pure source of truth for editing, totals and print. */
(function(root,create){
  const api=create();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.KristaOfferV2=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  let serial=0;
  const id=prefix=>prefix+"-"+Date.now().toString(36)+"-"+(++serial).toString(36);
  const copy=x=>JSON.parse(JSON.stringify(x));
  const amount=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(n,1e9):0};
  const round=v=>Math.round((v+Number.EPSILON)*100)/100;
  const clean=(v,limit=250)=>String(v??"").slice(0,limit);
  const esc=v=>clean(v,12000).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const currency=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",minimumFractionDigits:2,maximumFractionDigits:2}).format(round(v));
  const number=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:2}).format(round(v));
  const catalog=Object.freeze([
    {id:"cover",category:"Abdecken",text:"Abdeck- und Schutzarbeiten – Böden und Laufwege schützen",unit:"m²",price:2.58},
    {id:"prepare-wall",category:"Vorbereitung",text:"Untergrund spachteln für Tapete",unit:"m²",price:30},
    {id:"prime",category:"Vorbereitung",text:"Untergrund fachgerecht grundieren",unit:"m²",price:0},
    {id:"paint-wall",category:"Malerarbeiten",text:"Wände mit hochwertiger Dispersionsfarbe deckend streichen",unit:"m²",price:8.14},
    {id:"paint-ceiling",category:"Malerarbeiten",text:"Decken mit hochwertiger Dispersionsfarbe deckend streichen",unit:"m²",price:8.14},
    {id:"acryl",category:"Malerarbeiten",text:"Anschlussfugen fachgerecht mit Acryl schließen",unit:"m",price:2.24},
    {id:"wallpaper",category:"Tapeten",text:"Tapete nach Herstellervorgabe fachgerecht verkleben",unit:"m²",price:0},
    {id:"regie",category:"Regie",text:"Facharbeiterstunden nach tatsächlichem Aufwand",unit:"Std",price:75},
    {id:"material",category:"Regie",text:"Material und Maschinen nach Aufstellung",unit:"PA",price:0},
    {id:"free",category:"Eigene Leistung",text:"Neue freie Position",unit:"PA",price:0}
  ]);
  const position=template=>({id:id("pos"),text:clean(template?.text||"Neue Position",1000),unit:clean(template?.unit||"PA",20),unitPrice:amount(template?.price??template?.unitPrice??0),quantityMode:"manual",quantity:1,measurementIds:[],alternative:false,notes:""});
  const room=title=>({id:id("room"),name:clean(title||"Neuer Raum / Bauteil"),description:"",adjustmentPercent:0,positions:[]});
  const measurement=(roomId="",name="Neues Aufmaß",unit="m²",formula="")=>({id:id("measure"),roomId,label:clean(name),unit:clean(unit),formula:clean(formula,400)});
  const section=title=>({id:id("section"),name:clean(title||"Neuer Abschnitt"),showUnitPrices:true,measurements:[],rooms:[room("Raum 1")]});
  function fresh(){
    return {schemaVersion:2,documentId:id("offer"),number:"TEST-ENTWURF",title:"Neues Angebot",customer:"",address:"",
      intro:"Wir bedanken uns für Ihre Anfrage und bieten folgende Leistungen an.",sections:[section("Malerarbeiten")],
      discountPercent:0,vatRate:20,cashDiscountPercent:2,cashDiscountDays:5,netPaymentDays:14,advancePercent:50,advanceDiscountPercent:4,createdDate:new Date().toISOString().slice(0,10)};
  }
  // Strict arithmetic parser; deliberately never evaluate JS supplied by a user.
  function formulaValue(source){
    if(/\b0[xX][0-9a-fA-F]+\b/.test(String(source??"")))throw new Error("Hex-Zahlen sind im Aufmaß nicht erlaubt.");
    const input=String(source??"").trim().replace(/,/g,".").replace(/[×xX]/g,"*").replace(/[÷:]/g,"/").replace(/[−–]/g,"-").replace(/\s+/g,"");
    if(!input)return null;
    const tokens=[];let p=0;
    while(p<input.length){
      const part=input.slice(p),m=part.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if(m){tokens.push(m[0]);p+=m[0].length;continue;}
      if("()+-*/".includes(input[p])){tokens.push(input[p++]);continue;}
      throw new Error("Ungültiges Zeichen im Aufmaß.");
    }
    if(tokens.length>160)throw new Error("Aufmaßformel zu lang.");
    let i=0;
    const atom=()=>{
      if(tokens[i]==="+"){i++;return atom();}
      if(tokens[i]==="-"){i++;return -atom();}
      if(tokens[i]==="("){i++;const val=sum();if(tokens[i++]!==")")throw new Error("Klammer im Aufmaß fehlt.");return val;}
      const value=tokens[i++];
      if(value===undefined||!(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)))throw new Error("Aufmaßformel unvollständig.");
      return Number(value);
    };
    const product=()=>{let val=atom();while(tokens[i]==="*"||tokens[i]==="/"){const op=tokens[i++],n=atom();if(op==="/"&&n===0)throw new Error("Division durch null.");val=op==="*"?val*n:val/n;}return val;};
    const sum=()=>{let val=product();while(tokens[i]==="+"||tokens[i]==="-"){const op=tokens[i++],n=product();val=op==="+"?val+n:val-n;}return val;};
    const result=sum();
    if(i!==tokens.length||!Number.isFinite(result)||result<0||result>1e9)throw new Error("Aufmaß ergibt keinen gültigen positiven Wert.");
    return round(result);
  }
  function measured(line){
    try{
      if(Array.isArray(line.calculations)&&line.calculations.length){
        let total=0,hasValue=false;
        for(const item of line.calculations){
          const value=formulaValue(item.formula);
          if(value===null)continue;
          hasValue=true;
          total+=(item.deduction?-1:1)*Math.abs(value);
        }
        return{value:hasValue?round(total):null,error:null};
      }
      return{value:formulaValue(line.formula),error:null};
    }catch(error){return{value:null,error:String(error.message||error)};}
  }
  function positionQuantity(sec,p){
    if(p.quantityMode!=="linked")return {value:amount(p.quantity),error:null};
    const selected=Array.isArray(p.measurementIds)?p.measurementIds:[];
    if(!selected.length)return{value:0,error:"Keine Aufmaßzeile zugeordnet"};
    let total=0;
    for(const sourceId of selected){
      const m=(sec.measurements||[]).find(x=>x.id===sourceId);
      if(!m)return{value:0,error:"Zugeordnetes Aufmaß fehlt"};
      if(String(m.unit)!==String(p.unit))return{value:0,error:"Einheit stimmt nicht überein ("+m.unit+" / "+p.unit+")"};
      const value=measured(m);
      if(value.error||value.value===null)return{value:0,error:value.error||"Aufmaßformel fehlt"};
      total+=value.value;
    }
    return {value:round(total),error:null};
  }
  function isRegieMaterial(p){return p.alwaysShowUnitPrice===true||/^(Std\.?|Stunden?|h)$/i.test(String(p.unit||"").trim())||/^Material und Maschinen/i.test(String(p.text||""));}
  function roomAdjustment(r,p){return isRegieMaterial(p)?0:Math.max(-100,Math.min(100,Number(r.adjustmentPercent)||0));}
  function totals(offer){
    const errors=[];let before=0;let alternatives=0;
    const sections=(offer.sections||[]).map(sec=>{
      let sectionSum=0;
      const rooms=(sec.rooms||[]).map(r=>{
        let roomSum=0;
        const positions=(r.positions||[]).map(p=>{
          const q=positionQuantity(sec,p);
          if(q.error)errors.push(sec.name+" / "+r.name+": "+p.text+" – "+q.error);
          const baseNet=round(q.value*amount(p.unitPrice));
          const adjustment=roomAdjustment(r,p);
          const net=round(baseNet*(1+adjustment/100));
          if(p.alternative)alternatives+=net;else roomSum=round(roomSum+net);
          return{positionId:p.id,quantity:q.value,net,adjustment,baseNet,error:q.error,alternative:!!p.alternative};
        });
        sectionSum=round(sectionSum+roomSum);
        return{roomId:r.id,total:roomSum,positions};
      });
      before=round(before+sectionSum);
      return{sectionId:sec.id,total:sectionSum,rooms};
    });
    const discount=round(before*Math.min(100,amount(offer.discountPercent))/100);
    const net=round(before-discount),vat=round(net*Math.min(100,amount(offer.vatRate))/100),gross=round(net+vat);
    return{sections,base:before,discount,net,vat,gross,alternatives,errors};
  }
  function findSection(offer,sectionId){return (offer.sections||[]).find(x=>x.id===sectionId)||null;}
  function findRoom(offer,sectionId,roomId){return findSection(offer,sectionId)?.rooms.find(x=>x.id===roomId)||null;}
  function addSection(offer,mode="new"){
    const prev=offer.sections.at(-1),next=section("Abschnitt "+(offer.sections.length+1));
    if(prev&&["copy","extend"].includes(mode)){
      const ids=new Map();
      next.rooms=prev.rooms.map(r=>{const created=room(r.name);ids.set(r.id,created.id);created.description=r.description||"";return created;});
      next.measurements=prev.measurements.map(line=>({...line,id:id("measure"),roomId:ids.get(line.roomId)||""}));
      if(mode==="extend")next.measurements.push(measurement(next.rooms[0]?.id||"","Zusätzliches Aufmaß"));
    }
    offer.sections.push(next);return next;
  }
  function addRoom(offer,sectionId,name){const sec=findSection(offer,sectionId);if(!sec)throw Error("Abschnitt nicht gefunden");const r=room(name||"Raum "+(sec.rooms.length+1));sec.rooms.push(r);return r;}
  function addMeasurement(offer,sectionId,roomId=""){const sec=findSection(offer,sectionId);if(!sec)throw Error("Abschnitt nicht gefunden");const item=measurement(roomId);sec.measurements.push(item);return item;}
  function addPosition(offer,sectionId,roomId,templateId="free"){
    const r=findRoom(offer,sectionId,roomId);if(!r)throw Error("Raum nicht gefunden");
    const template=catalog.find(x=>x.id===templateId)||catalog.find(x=>x.id==="free");
    const item=position(template);if(templateId==="regie"||templateId==="material")item.alwaysShowUnitPrice=true;r.positions.push(item);return item;
  }
  function addBulk(offer,sectionId,roomId,templateIds){
    return [...new Set(templateIds||[])].map(key=>addPosition(offer,sectionId,roomId,key));
  }
  function removePosition(offer,sectionId,roomId,positionId){
    const r=findRoom(offer,sectionId,roomId);if(!r)return false;
    const index=r.positions.findIndex(p=>p.id===positionId);
    if(index<0)return false;
    r.positions.splice(index,1);return true;
  }
  function duplicatePosition(offer,sectionId,roomId,positionId){
    const r=findRoom(offer,sectionId,roomId);if(!r)return null;
    const original=r.positions.find(p=>p.id===positionId);if(!original)return null;
    const next={...copy(original),id:id("pos")};
    r.positions.splice(r.positions.indexOf(original)+1,0,next);return next;
  }
  function reorder(items,elementId,delta){
    const idx=items.findIndex(x=>x.id===elementId),next=idx+delta;
    if(idx<0||next<0||next>=items.length)return false;
    const [item]=items.splice(idx,1);items.splice(next,0,item);return true;
  }
  function sample(){
    const o=fresh();
    o.title="Eingang + Stiegenhaus · Familie Wallner";
    o.customer="Familie Wallner";o.address="Vorarlberg";o.number="TEST-WALLNER";o.sections=[];
    const s=addSection(o);
    s.name="Malerarbeiten";
    s.rooms[0].name="Eingang";
    const r=s.rooms[0];r.description="Wände vorbereiten und beschichten";
    const m=measurement(r.id,"Wandflächen Eingang","m²","22,14");
    const a=measurement(r.id,"Anschlussfugen","m","22");
    s.measurements.push(m,a);
    for(const key of ["prepare-wall","paint-wall","acryl"]){
      const p=addPosition(o,s.id,r.id,key);p.quantityMode="linked";p.measurementIds=[key==="acryl"?a.id:m.id];
    }
    const stair=addRoom(o,s.id,"Stiegenhaus");
    const ceiling=measurement(stair.id,"Deckenfläche Stiegenhaus","m²","12,8");s.measurements.push(ceiling);
    const p=addPosition(o,s.id,stair.id,"paint-ceiling");p.quantityMode="linked";p.measurementIds=[ceiling.id];
    const next=addSection(o,"extend");next.name="Ergänzungen";next.rooms[0].name="Eingang – Zusatzarbeiten";
    return o;
  }
  // Legacy v3/v5 offer-draft conversion preserves existing line descriptions,
  // prices, quantities and room association, without applying old generators.
  function fromLegacy(payload){
    const old=payload?.draft||payload;if(!old||!Array.isArray(old.positions))throw Error("Kein KRISTINE-Angebotsentwurf.");
    const o=fresh();o.title=clean(old.title||old.scopeDescription||"Übernommenes Angebot");
    o.number=clean(old.offerNumber||"TEST-IMPORT");o.intro=clean(old.intro||"",1500);o.sections=[];
    const sec=addSection(o);sec.name="Übernommene Leistungen";sec.rooms=[];
    const byName=new Map();
    for(const source of old.rooms||[]){
      const newRoom=room(source.name||"Raum");sec.rooms.push(newRoom);
      byName.set(String(source.id||source.name),newRoom);
    }
    for(const oldPos of old.positions){
      const key=String(oldPos.groupId||oldPos.groupName||"Allgemein");
      let target=byName.get(key)||sec.rooms.find(r=>r.name===oldPos.groupName);
      if(!target){target=room(oldPos.groupName||"Weitere Leistungen");sec.rooms.push(target);byName.set(key,target);}
      const item=position({text:oldPos.text,unit:oldPos.unit,unitPrice:oldPos.unitPrice});
      item.quantity=amount(oldPos.quantity);item.alternative=oldPos.isAlternative===true;
      target.positions.push(item);
    }
    if(!sec.rooms.length)sec.rooms.push(room("Raum 1"));
    if(old.financials){o.discountPercent=amount(old.financials.discountPercent);o.vatRate=amount(old.financials.vatRate??20);}
    return o;
  }
  function parseOffer(value){
    if(!value||typeof value!=="object")throw Error("Ungültige Angebotsdatei.");
    if(value.schemaVersion===2&&Array.isArray(value.sections)){
      if(value.sections.length>60||value.sections.some(s=>(s.rooms||[]).length>100||(s.measurements||[]).length>500||s.rooms?.some(r=>(r.positions||[]).length>500)))throw Error("Angebot enthält zu viele Einträge.");
      return copy(value);
    }
    return fromLegacy(value);
  }
  function printMarkup(offer){
    const calc=totals(offer);
    if(calc.errors.length)throw Error("Aufmaß bitte prüfen: "+calc.errors[0]);
    let html='<article class="offer-print"><header class="offer-print-head"><div class="offer-print-brand">FARBEN KRISTA <small>ANGEBOT V2 · TESTENTWURF</small></div><div>Nr. '+esc(offer.number||"TEST")+'</div></header>';
    const street=[offer.street,offer.houseNumber].filter(Boolean).join(" ");
    const place=[offer.postalCode,offer.city].filter(Boolean).join(" ");
    const address=[offer.customer||"Kunde noch offen",offer.contactName,street,place,offer.country].filter(Boolean);
    if(!street&&!place&&offer.address)address.push(offer.address);
    html+='<h1>Angebot</h1><p class="print-intro">'+address.map(esc).join('<br>')+'</p>';
    html+='<h2>'+esc(offer.title)+'</h2><p class="print-intro">'+esc(offer.intro||"")+'</p>';
    const date=v=>{const parts=String(v||"").split("-");return parts.length===3?parts.reverse().join("."):"";};
    const execution=offer.executionMode==="date"?(date(offer.executionDate)||"Nach Absprache"):offer.executionMode==="period"?([date(offer.executionStart),date(offer.executionEnd)].filter(Boolean).join(" – ")||"Nach Absprache"):"Nach Absprache";
    html+='<p class="print-intro"><strong>Ausführungstermin:</strong> '+esc(execution)+'</p>';
    (offer.sections||[]).forEach((sec,i)=>{
      html+='<section class="offer-print-section"><h3>'+(i+1)+'. '+esc(sec.name)+'</h3>';
      (sec.rooms||[]).forEach((r,j)=>{
        const summary=calc.sections[i].rooms[j];
        if(!r.positions.length)return;
        html+='<h4>'+esc(r.name)+'</h4>';
        if(r.description)html+='<p class="print-room-desc">'+esc(r.description)+'</p>';
        html+='<table><thead><tr><th>Pos.</th><th>Leistung</th><th class="num">Menge</th><th>EH</th><th class="num">EP</th><th class="num">Gesamt</th></tr></thead><tbody>';
        r.positions.forEach((p,k)=>{
          const q=summary.positions[k],alt=q.alternative;
          const details=(r.showUnitPrices===true||(r.showUnitPrices!==false&&sec.showUnitPrices!==false&&offer.showUnitPrices!==false))||p.alwaysShowUnitPrice===true||/^(Std\.?|Stunden?|h)$/i.test(String(p.unit||"").trim())||/^Material und Maschinen/i.test(p.text||"");
          html+='<tr'+(alt?' class="print-alternative"':'')+'><td>'+(i+1)+'.'+(j+1)+'.'+(k+1)+'</td><td>'+esc(p.text)+(q.adjustment?'<small class="print-position-adjust"> ('+(q.adjustment>0?'+':'')+number(q.adjustment)+' %)</small>':'')+(alt?' <em>(Alternative)</em>':'')+'</td><td class="num">'+(details?number(q.quantity):'')+'</td><td>'+(details?esc(p.unit):'')+'</td><td class="num">'+(details?currency(round(amount(p.unitPrice)*(1+q.adjustment/100))):'')+'</td><td class="num">'+(alt?'nicht enthalten':currency(q.net))+'</td></tr>';
        });
        html+='</tbody><tfoot><tr><td colspan="5">Summe '+esc(r.name)+'</td><td class="num">'+currency(summary.total)+'</td></tr></tfoot></table>';
      });
      html+='</section>';
    });
    html+='<section class="print-grand"><h3>Zusammenfassung</h3>';
    offer.sections.forEach((sec,i)=>{html+='<div><span>'+(i+1)+'. '+esc(sec.name)+'</span><strong>'+currency(calc.sections[i].total)+'</strong></div>';});
    if(calc.discount)html+='<div>Rabatt '+number(offer.discountPercent)+' % <strong>− '+currency(calc.discount)+'</strong></div>';
    html+='<div class="print-summary-net">Angebotssumme netto <strong>'+currency(calc.net)+'</strong></div><div>'+number(offer.vatRate)+' % MwSt. <strong>'+currency(calc.vat)+'</strong></div><div class="final">Angebotssumme brutto <strong>'+currency(calc.gross)+'</strong></div></section><footer>KRISTINE Angebotseditor V2 · isolierte Testfassung · kein verbindliches Kundenangebot</footer></article>';
    return html;
  }
  return{catalog,currency,number,fresh,sample,formulaValue,measured,positionQuantity,totals,findSection,findRoom,addSection,addRoom,addMeasurement,addPosition,addBulk,removePosition,duplicatePosition,reorder,parseOffer,fromLegacy,printMarkup,copy,esc,id};
});

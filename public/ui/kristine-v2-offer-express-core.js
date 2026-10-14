"use strict";
/* KRISTINE Angebots-Express V2: isolated, deterministic offer draft model.
   There is NO network connection, no live customer database, no quote submission.
   Demo rates are deliberately unconfirmed until checked by a human. */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.KristaOfferExpressCore=api;
})(typeof window==="object"?window:null,function(){
  const CATALOG=[
    {key:"cover",group:"Vorbereitung",text:"Bodenflächen und Laufwege fachgerecht abdecken",unit:"m²",price:2.58,basis:"floor"},
    {key:"tape",group:"Vorbereitung",text:"Fußleisten und Anschlüsse abkleben",unit:"m",price:1.05,basis:"linear"},
    {key:"clean",group:"Vorbereitung",text:"Untergrund reinigen und vorbereiten",unit:"m²",price:null,basis:"walls"},
    {key:"filler",group:"Malerarbeiten",text:"Untergrund für Tapete vollflächig spachteln",unit:"m²",price:null,basis:"walls"},
    {key:"sand",group:"Malerarbeiten",text:"Untergrund schleifen und entstauben",unit:"m²",price:null,basis:"walls"},
    {key:"primer",group:"Malerarbeiten",text:"Untergrund fachgerecht grundieren",unit:"m²",price:null,basis:"walls"},
    {key:"paint",group:"Malerarbeiten",text:"Wände mit hochwertiger Dispersion streichen",unit:"m²",price:8.14,basis:"walls"},
    {key:"ceiling",group:"Malerarbeiten",text:"Decken mit hochwertiger Dispersion streichen",unit:"m²",price:8.14,basis:"ceiling"},
    {key:"acryl",group:"Malerarbeiten",text:"Anschlussfugen mit Acryl herstellen",unit:"m",price:2.24,basis:"linear"},
    {key:"wallpaper",group:"Tapezierarbeiten",text:"Tapete fachgerecht anbringen",unit:"m²",price:null,basis:"walls"},
    {key:"facade-wash",group:"Fassade",text:"Fassadenflächen schonend reinigen",unit:"m²",price:3.18,basis:"walls"},
    {key:"facade-primer",group:"Fassade",text:"Fassadenflächen grundieren",unit:"m²",price:2.63,basis:"walls"},
    {key:"facade-paint",group:"Fassade",text:"Fassade zweimal beschichten",unit:"m²",price:20.11,basis:"walls"},
    {key:"bath-prep",group:"Fugenloses Bad",text:"Untergrund für fugenlosen Aufbau vorbereiten",unit:"m²",price:11.50,basis:"walls"},
    {key:"bath-water",group:"Fugenloses Bad",text:"Dusch- und Bodenflächen abdichten",unit:"m²",price:null,basis:"walls"},
    {key:"bath-finish",group:"Fugenloses Bad",text:"Fugenlosen Unikatbelag herstellen und versiegeln",unit:"m²",price:null,basis:"walls"},
    {key:"regie",group:"Regie",text:"Facharbeiterstunden nach Aufwand",unit:"Std",price:75,basis:"manual"},
    {key:"material",group:"Regie",text:"Material laut tatsächlichem Verbrauch",unit:"VE",price:null,basis:"manual"}
  ];
  const PACKAGES={
    "innen":["cover","filler","primer","paint","ceiling","acryl"],
    "einfach":["cover","paint","ceiling"],
    "tapete":["cover","filler","sand","primer","wallpaper"],
    "fassade":["facade-wash","facade-primer","facade-paint"],
    "bad":["bath-prep","bath-water","bath-finish"],
    "regie":["regie","material"]
  };
  const MEASURES=["walls","ceiling","floor","linear","pieces"];
  const BASIS_LABELS={walls:"Wände",ceiling:"Decke",floor:"Boden",linear:"Laufmeter",pieces:"Stück",manual:"Eigene Menge"};
  const money=n=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
  const parseNumber=v=>{
    if(v==null||String(v).trim()==="")return null;
    const raw=String(v).trim().replace(/\s/g,"");
    const normalized=raw.includes(",")?raw.replace(/\./g,"").replace(",","."):(raw.match(/\./g)||[]).length>1?raw.replace(/\./g,""):raw;
    const n=typeof v==="number"?v:Number(normalized);
    return Number.isFinite(n)&&n>=0?n:null;
  };
  const round2=n=>Math.round((n+Number.EPSILON)*100)/100;
  function nextId(draft,prefix){
    draft.seq=(Number(draft.seq)||0)+1;
    return prefix+"-"+draft.seq;
  }
  function room(draft,name,source){
    const m={walls:null,ceiling:null,floor:null,linear:null,pieces:null};
    if(source&&source.measures)for(const k of MEASURES)m[k]=source.measures[k]??null;
    return{id:nextId(draft,"room"),name:name||"Raum / Bauteil",measures:m};
  }
  function section(draft,name,mode,source){
    const originals=mode==="neu"?[]:source?.rooms||[];
    const rooms=originals.length?originals.map(src=>room(draft,src.name,src)):[room(draft,"Raum / Bauteil",null)];
    const value={id:nextId(draft,"section"),name:name||"Malerarbeiten",rooms,positions:[],notes:""};
    draft.sections.push(value);
    return value;
  }
  function createDraft(customer,title){
    const draft={version:2,seq:0,customer:String(customer||"").trim(),title:String(title||"Angebotsentwurf").trim(),vat:20,sections:[],source:"isolated-demo",createdAt:new Date().toISOString()};
    section(draft,"Abschnitt 1 · Malerarbeiten","neu");
    return draft;
  }
  function getSection(draft,id){return draft.sections.find(s=>s.id===id)||null}
  function getRoom(sec,id){return sec?.rooms?.find(r=>r.id===id)||sec?.rooms?.[0]||null}
  function template(key){return CATALOG.find(x=>x.key===key)||null}
  function addPosition(draft,sectionId,key,roomId){
    const sec=getSection(draft,sectionId),cat=template(key);
    if(!sec||!cat)return null;
    const target=getRoom(sec,roomId);
    const p={id:nextId(draft,"pos"),templateKey:key,text:cat.text,unit:cat.unit,quantity:null,basis:cat.basis,roomId:target.id,unitPrice:cat.price,priceConfirmed:false};
    if(cat.basis!=="manual")p.quantity=target.measures[cat.basis]??null;
    sec.positions.push(p);
    return p;
  }
  function addPackage(draft,sectionId,key,roomId){
    const keys=PACKAGES[key]||[];
    return keys.map(k=>addPosition(draft,sectionId,k,roomId)).filter(Boolean);
  }
  function removePosition(draft,sectionId,positionId){
    const sec=getSection(draft,sectionId);
    if(!sec)return false;
    const ix=sec.positions.findIndex(p=>p.id===positionId);
    if(ix<0)return false;
    sec.positions.splice(ix,1);
    return true;
  }
  function changeRoomMeasure(draft,sectionId,roomId,basis,input){
    const sec=getSection(draft,sectionId),target=getRoom(sec,roomId);
    if(!sec||!target||!MEASURES.includes(basis))return;
    target.measures[basis]=parseNumber(input);
    for(const p of sec.positions)
      if(p.roomId===target.id&&p.basis===basis)p.quantity=target.measures[basis];
  }
  function setBasis(draft,sectionId,positionId,basis){
    const sec=getSection(draft,sectionId),p=sec?.positions.find(x=>x.id===positionId);
    if(!p||!(MEASURES.includes(basis)||basis==="manual"))return;
    p.basis=basis;
    if(basis!=="manual")p.quantity=getRoom(sec,p.roomId)?.measures[basis]??null;
  }
  function setRoom(draft,sectionId,positionId,roomId){
    const sec=getSection(draft,sectionId),p=sec?.positions.find(x=>x.id===positionId);
    if(!p||!sec.rooms.some(r=>r.id===roomId))return;
    p.roomId=roomId;
    if(p.basis!=="manual")p.quantity=getRoom(sec,roomId)?.measures[p.basis]??null;
  }
  function setQuantity(draft,sectionId,positionId,input){
    const sec=getSection(draft,sectionId),p=sec?.positions.find(x=>x.id===positionId);
    if(!p)return;
    p.basis="manual";p.quantity=parseNumber(input);
  }
  function setRate(draft,sectionId,positionId,input){
    const sec=getSection(draft,sectionId),p=sec?.positions.find(x=>x.id===positionId);
    if(!p)return;
    p.unitPrice=parseNumber(input);p.priceConfirmed=p.unitPrice!==null;
  }
  function movePosition(draft,sectionId,positionId,direction){
    const sec=getSection(draft,sectionId),ix=sec?.positions.findIndex(x=>x.id===positionId)??-1,j=ix+direction;
    if(ix<0||j<0||j>=sec.positions.length)return false;
    const [p]=sec.positions.splice(ix,1);sec.positions.splice(j,0,p);return true;
  }
  function addRoom(draft,sectionId,name,copy){
    const sec=getSection(draft,sectionId);
    if(!sec)return null;
    const created=room(draft,name||"Weiterer Raum",copy?sec.rooms[0]:null);
    sec.rooms.push(created);return created;
  }
  function addSection(draft,name,mode,sourceId){
    return section(draft,name,mode,getSection(draft,sourceId));
  }
  function sum(draft){
    let net=0, missingQuantity=0,missingRate=0,unconfirmedRate=0,lines=0;
    for(const s of draft.sections)for(const p of s.positions){
      lines++;
      if(p.quantity===null)missingQuantity++;
      if(p.unitPrice===null)missingRate++;
      if(p.unitPrice!==null&&!p.priceConfirmed)unconfirmedRate++;
      if(p.quantity!==null&&p.unitPrice!==null)net+=p.quantity*p.unitPrice;
    }
    net=round2(net);
    const vat=round2(net*(Number(draft.vat)||0)/100);
    return{net,vat,gross:round2(net+vat),lines,missingQuantity,missingRate,unconfirmedRate,
      ready:lines>0&&missingQuantity===0&&missingRate===0&&unconfirmedRate===0};
  }
  function matchArea(input,label){
    const s=String(input||"").replace(/\u00a0/g," ");
    const variants={
      walls:"(?:w[aä]nde|wandfl[aä]che[n]?)",
      ceiling:"(?:decken?|deckenfl[aä]che)",
      floor:"(?:b[oö]den?|bodenfl[aä]che)",
      linear:"(?:acryl(?:fugen)?|fugen|laufmeter|lfm)",
      pieces:"(?:t[uü]ren|fenster|st[uü]ck|stk)"
    };
    const prefix=new RegExp(variants[label]+"[^\\d]{0,14}(\\d+(?:[.,]\\d+)?)\\s*(?:m²|m2|qm|m|lfm|stk|st[uü]ck)?","i");
    const suffix=new RegExp("(\\d+(?:[.,]\\d+)?)\\s*(?:m²|m2|qm|m|lfm|stk)?\\s*"+variants[label],"i");
    const m=s.match(prefix)||s.match(suffix);
    return m?parseNumber(m[1]):null;
  }
  function parseBrief(text,chosenPackage){
    const raw=String(text||"").trim();
    const measures={};
    for(const key of MEASURES)measures[key]=matchArea(raw,key);
    const lower=raw.toLocaleLowerCase("de-AT");
    let name=raw.split(/[:\n]/)[0].split(",")[0].trim();
    if(name.length>65||name.length<3||/^(bitte|angebot|malerarbeiten|neue)/i.test(name))name="Eingang / Stiegenhaus";
    const services=[
      [/abdeck|schutzvlies/,["cover"]],
      [/spachtel/,["filler"]],
      [/schleif/,["sand"]],
      [/grundier/,["primer"]],
      [/tapet/,["wallpaper"]],
      [/streich|dispers|ausmal/,["paint"]],
      [/decke(n)?\s*(?:streichen|beschichten)/,["ceiling"]],
      [/acryl|fugen/,["acryl"]],
      [/fassade.*wasch|fassade.*reinig/,["facade-wash"]],
      [/fassade.*(?:anstrich|beschicht)/,["facade-paint"]]
    ];
    let selected=[];
    for(const [pattern,keys] of services)if(pattern.test(lower))selected.push(...keys);
    if(!selected.length)selected=(PACKAGES[chosenPackage]||PACKAGES.einfach).slice();
    if(measures.ceiling!==null&&selected.includes("paint")&&!selected.includes("ceiling"))selected.push("ceiling");
    selected=[...new Set(selected)];
    return{name,measures,selected,brief:raw};
  }
  function fromBrief(customer,title,brief,packageKey){
    const d=createDraft(customer,title);
    const part=parseBrief(brief,packageKey),s=d.sections[0],r=s.rooms[0];
    r.name=part.name;s.name="Abschnitt 1 · "+(packageKey==="fassade"?"Fassade":packageKey==="bad"?"Fugenloses Bad":"Malerarbeiten");
    s.notes=part.brief;
    for(const key of MEASURES)r.measures[key]=part.measures[key];
    for(const key of part.selected)addPosition(d,s.id,key,r.id);
    return d;
  }
  function validate(draft){
    if(!draft||!Array.isArray(draft.sections)||draft.sections.length>30)throw Error("Ungültiger Angebotsentwurf");
    for(const sec of draft.sections){
      if(!Array.isArray(sec.rooms)||!Array.isArray(sec.positions)||sec.positions.length>200)throw Error("Ungültige Abschnitte");
      const ids=new Set(sec.rooms.map(r=>r.id));
      for(const p of sec.positions){
        if(!ids.has(p.roomId))throw Error("Position ohne Raumzuordnung");
        if(p.quantity!==null&&(!Number.isFinite(p.quantity)||p.quantity<0))throw Error("Ungültige Menge");
        if(p.unitPrice!==null&&(!Number.isFinite(p.unitPrice)||p.unitPrice<0))throw Error("Ungültiger Preis");
      }
    }
    return true;
  }
  return{CATALOG,PACKAGES,MEASURES,BASIS_LABELS,money,parseNumber,createDraft,addSection,addRoom,getSection,
    getRoom,template,addPackage,addPosition,removePosition,changeRoomMeasure,setBasis,setRoom,setQuantity,
    setRate,movePosition,sum,parseBrief,fromBrief,validate};
});

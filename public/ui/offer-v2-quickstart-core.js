"use strict";
/* KRISTINE 2.0 Schnellstart: creates the EXACT same offer model used by Offer V2.
   Pure, deterministic, offline. No live API calls, no invented measurements. */
(function(root,factory){
  const C=root?.KristaOfferV2||(typeof module==="object"&&module.exports?require("./offer-v2-core"):null);
  const api=factory(C);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.KristaOfferV2Quick=api;
})(typeof window!=="undefined"?window:null,function(C){
  if(!C)throw Error("Angebotsstudio V2 Kern fehlt");
  const PACKAGES=Object.freeze({
    innen:["cover","prepare-wall","prime","paint-wall","paint-ceiling","acryl"],
    einfach:["cover","paint-wall","paint-ceiling"],
    tapete:["cover","prepare-wall","prime","wallpaper"],
    regie:["regie","material"]
  });
  const MEASURES=[
    {key:"walls",label:"Wände",unit:"m²",pattern:"(?:w[aä]nde|wandfl[aä]chen?)"},
    {key:"ceiling",label:"Decke",unit:"m²",pattern:"(?:decken?|deckenfl[aä]che)"},
    {key:"floor",label:"Boden",unit:"m²",pattern:"(?:b[oö]den?|bodenfl[aä]che)"},
    {key:"linear",label:"Anschlussfugen",unit:"m",pattern:"(?:acrylfugen|fugen|laufmeter|lfm)"},
    {key:"hours",label:"Regiestunden",unit:"Std",pattern:"(?:regie|arbeitsstunden|stunden)"}
  ];
  const BASIS={
    cover:"floor","prepare-wall":"walls",prime:"walls","paint-wall":"walls",
    "paint-ceiling":"ceiling",acryl:"linear",wallpaper:"walls",regie:"hours"
  };
  function num(value){
    const s=String(value??"").trim().replace(/\s/g,"");
    if(!s||!/^\d+(?:[.,]\d+)?$/.test(s))return null;
    const n=Number(s.replace(",","."));
    return Number.isFinite(n)&&n>=0?n:null;
  }
  function explicitArea(text,part){
    const alias=part.pattern,unit=part.unit==="m²"?"(?:m²|m2|qm|quadratmeter)":part.unit==="Std"?"(?:h|std|stunden)":"(?:lfm|m|meter)";
    const amount="(\\d+(?:[.,]\\d+)?)";
    const first=new RegExp(alias+"\\s*(?:[:=]|ca\\.|rund)?\\s*"+amount+"\\s*"+unit,"i");
    const second=new RegExp(amount+"\\s*"+unit+"\\s*"+alias,"i");
    const hit=String(text||"").match(first)||String(text||"").match(second);
    return hit?num(hit[1]):null;
  }
  function detect(text,preset){
    const raw=String(text||"").trim(),low=raw.toLocaleLowerCase("de-AT");
    const measure={};
    for(const row of MEASURES)measure[row.key]=explicitArea(raw,row);
    const cues=[
      [/abdeck|schutzvlies/,["cover"]],
      [/spachtel|untergrund.*gl[äa]tt/,["prepare-wall"]],
      [/grundier/,["prime"]],
      [/tapet/,["wallpaper"]],
      [/streich|beschicht|ausmal|dispers/,["paint-wall"]],
      [/acryl|anschlussfugen/,["acryl"]],
      [/\bregie\b/,["regie","material"]]
    ];
    let keys=[];
    for(const [pattern,ids] of cues)if(pattern.test(low))keys.push(...ids);
    if((/\bdecke[n]?\b/.test(low)||measure.ceiling!==null)&&keys.includes("paint-wall"))keys.push("paint-ceiling");
    if(!keys.length)keys=(PACKAGES[preset]||PACKAGES.einfach).slice();
    keys=[...new Set(keys)];
    const head=raw.split(/[:\n]/)[0].split(",")[0].trim();
    const roomName=head&&head.length<=65&&!/^(bitte|angebot|malerarbeiten)/i.test(head)?head:"Raum / Bauteil";
    return{roomName,measure,keys,brief:raw,preset};
  }
  function build({customer,title,brief,preset="innen"}={}){
    const name=String(customer||"").trim(),project=String(title||"").trim();
    if(!name)throw Error("Bitte den Kundennamen eingeben.");
    if(!String(brief||"").trim())throw Error("Bitte die Leistungen kurz beschreiben.");
    const info=detect(brief,preset);
    const offer=C.fresh();
    offer.customer=name;
    offer.title=project||"Angebot · "+info.roomName;
    offer.number="TEST-SCHNELLSTART";
    offer.intro="Angebotsentwurf auf Grundlage der beschriebenen Leistungen. Aufmaß und Preise sind vor dem Versand zu prüfen.";
    const s=offer.sections[0],r=s.rooms[0];
    s.name=preset==="tapete"?"Tapezierarbeiten":preset==="regie"?"Regiearbeiten":"Malerarbeiten";
    r.name=info.roomName;
    r.description=info.brief.slice(0,1000);
    const linked=new Map();
    for(const part of MEASURES){
      const value=info.measure[part.key];
      if(value===null)continue;
      const m=C.addMeasurement(offer,s.id,r.id);
      m.label=part.label;
      m.unit=part.unit;
      m.formula=String(value).replace(".",",");
      linked.set(part.key,m.id);
    }
    const items=C.addBulk(offer,s.id,r.id,info.keys);
    for(let i=0;i<items.length;i++){
      const p=items[i],key=info.keys[i],basis=BASIS[key];
      const measureId=linked.get(basis);
      if(measureId){
        p.quantityMode="linked";
        p.measurementIds=[measureId];
      }else{
        p.quantityMode="manual";
        p.quantity=0; // explicitly unknown. Never silently assume 1 m² / 1 hour.
      }
    }
    const summary=C.totals(offer);
    const positions=items.map(p=>{
      const q=C.positionQuantity(s,p);
      return{id:p.id,text:p.text,quantity:q.value,unit:p.unit,unitPrice:p.unitPrice,
        needQuantity:q.value<=0||!!q.error,needPrice:!(Number(p.unitPrice)>0)};
    });
    return{offer,detected:info,positions,summary,missingQuantity:positions.filter(p=>p.needQuantity).length,
      missingPrice:positions.filter(p=>p.needPrice).length};
  }
  return{PACKAGES,MEASURES,BASIS,detect,build,num};
});

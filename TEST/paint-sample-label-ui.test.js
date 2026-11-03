"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM}=require("jsdom");

(async()=>{
  const dom=new JSDOM('<div class="tabs"></div><div class="wrap"></div>',{
    url:"https://protokoll.krista.at/admin/paint?token=sample-test",
    runScripts:"outside-only",
  });
  const w=dom.window;
  const requests=[];
  const savedHistory=[];
  let failLocalPrint=false;
  let failHistorySave=false;
  const respond=(data,status=200)=>({
    ok:status<400,status,json:async()=>data,clone:()=>respond(data,status),
  });
  w.fetch=async(url,options={})=>{
    const u=new URL(url,w.location.href);
    const body=options.body?JSON.parse(options.body):null;
    requests.push({path:u.pathname,query:u.searchParams,body,method:options.method||"GET"});
    if(u.pathname==="/health")return respond({ok:true,version:"1.7.0",printer:{available:true},scale:{available:true}});
    if(u.pathname==="/print")
      return failLocalPrint ? respond({ok:false,error:"Zebra offline"},503) : respond({ok:true,sampleLabel:true});
    if(u.pathname==="/admin/api/paint/sample-label-history"){
      if((options.method||"GET")==="POST"){
        if(failHistorySave)return respond({ok:false,error:"Historie aktuell nicht erreichbar"},503);
        const existing=savedHistory.find(item=>item.id===body.id);
        if(existing)return respond({ok:true,item:existing,existing:true});
        const item={...body,kind:"sample",printedAt:new Date().toISOString()};
        savedHistory.unshift(item);
        return respond({ok:true,item,existing:false});
      }
      const q=(u.searchParams.get("q")||"").toLowerCase();
      const results=savedHistory.filter(row=>[row.colour,row.material,row.reference].some(v=>String(v||"").toLowerCase().includes(q)));
      const offset=Number(u.searchParams.get("offset")||0),limit=Number(u.searchParams.get("limit")||20);
      return respond({ok:true,items:results.slice(offset,offset+limit),count:results.length,total:savedHistory.length});
    }
    if(u.pathname==="/admin/api/paint/returns/barcode"){
      const code=u.searchParams.get("code");
      if(code==="LG-65")return respond({ok:true,item:{returnLabel:"LG-65",colour:"Slaked Lime 105",material:"Intelligent Matt"}});
      return respond({ok:false,error:"not found"},404);
    }
    if(u.pathname==="/admin/api/paint/search")return respond({ok:true,results:
      u.searchParams.get("q")==="105"?[{id:105,code:"Slaked Lime 105",name:"Slaked Lime 105"}]:[]});
    if(u.pathname.endsWith("/jobs"))return respond({jobs:[]});
    if(u.pathname.endsWith("/materials"))return respond({materials:[]});
    return respond({ok:true,items:[],manufacturers:[]});
  };
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const tick=()=>new Promise(done=>setTimeout(done,80));
  try{
    for(const file of ["paint-return-stock-ui.js","paint-return-local-hardware-ui.js","paint-sample-label-ui.js"]){
      w.eval(fs.readFileSync(path.join(__dirname,"../public",file),"utf8"));
    }
    await tick();
    const el=id=>w.document.getElementById(id);
    assert(el("returnSampleLabelOpen"),"Neuer Musteretikett-Button fehlt");
    assert(el("returnSampleLabelHistoryOpen"),"Musteretikett-Historie ist separat erreichbar");
    assert(el("returnFreeLabelOpen"),"Bisheriger Freietikett-Button muss bleiben");
    el("returnSampleLabelOpen").click();
    assert.equal(el("returnSampleLabelDialog").open,true);
    assert.equal(el("samplePreview").querySelectorAll(".sample-logo-clip img").length,1);
    assert.equal(el("sampleDatePreview").textContent.length,10);

    // Neue und alte Rueckwaren werden ueber exakt ihre Archivnummer gefunden.
    el("sampleNumber").value="LG-65";
    el("sampleLookup").click();
    await tick();
    assert.equal(el("sampleColour").value,"Slaked Lime 105");
    assert.equal(el("sampleMaterial").value,"Intelligent Matt");
    el("sampleColour").value="Slaked Lime 105 - angepasst";
    el("sampleColour").dispatchEvent(new w.Event("input",{bubbles:true}));
    // Manueller Edit ist erlaubt, auch ohne LG Archiv.
    el("sampleColour").value="Eigener Farbton";
    el("sampleMaterial").value="Fremdfabrikat";
    el("sampleColour").dispatchEvent(new w.Event("input",{bubbles:true}));
    el("samplePrint").click();
    await tick();
    const sent=requests.filter(x=>x.path==="/print");
    assert.equal(sent.length,1);
    assert.deepEqual(sent[0].body,{sampleLabel:true,colour:"Eigener Farbton",material:"Fremdfabrikat"});
    assert.equal(sent[0].body.date,undefined);
    assert.equal(sent[0].body.logo,undefined);
    assert.equal(sent[0].body.smallLines,undefined);
    // Nur ein echter, bestaetigter Zebra-Druck erzeugt einen Historieneintrag.
    assert.equal(savedHistory.length,1);
    assert.equal(savedHistory[0].colour,"Eigener Farbton");
    assert.equal(savedHistory[0].material,"Fremdfabrikat");
    assert.equal(w.document.querySelectorAll("[data-sample-reuse]").length,1);
    const priorPrintCount=()=>requests.filter(x=>x.path==="/print").length;
    const countBeforeReuse=priorPrintCount();
    w.document.querySelector("[data-sample-reuse]").click();
    assert.equal(el("sampleColour").value,"Eigener Farbton");
    assert.equal(el("sampleMaterial").value,"Fremdfabrikat");
    assert.equal(priorPrintCount(),countBeforeReuse,"Uebernehmen darf NICHT automatisch drucken");
    // Beim Reprint wird ein weiterer echter Druck protokolliert,
    // aber kein alter Eintrag geloescht oder geaendert.
    w.document.querySelector("[data-sample-reprint]").click();
    await tick();
    assert.equal(priorPrintCount(),countBeforeReuse+1);
    assert.equal(savedHistory.length,2);
    assert.equal(savedHistory[0].colour,savedHistory[1].colour);
    assert.equal(el("sampleDatePreview").textContent.length,10);
    // Stichwortsuche funktioniert auch mit Material.
    el("sampleHistorySearch").value="Fremdfabrikat";
    el("sampleHistorySearch").dispatchEvent(new w.Event("input",{bubbles:true}));
    await new Promise(done=>setTimeout(done,300));
    assert.equal(w.document.querySelectorAll("[data-sample-reuse]").length,2);
    el("sampleHistorySearch").value="";
    el("sampleHistoryReload").click();
    await tick();

    el("sampleColour").value="";
    el("samplePrint").click();
    await tick();
    assert.equal(requests.filter(x=>x.path==="/print").length,2);
    el("sampleNumber").value="105";
    el("sampleLookup").click();
    await tick();
    // Fuer den gleichen Zahlencode gibt es einen Suchtreffer im alten LG-Archiv;
    // bei mehreren Quellen muss der Benutzer den richtigen Treffer waehlen.
    assert.equal(el("sampleColour").value,"Slaked Lime 105");
    assert(el("sampleMaterial").tagName==="INPUT");
    // Ein Zebra-Fehler DARF niemals als gedrucktes Muster protokolliert werden.
    el("sampleColour").value="Noch ein Muster";
    el("sampleMaterial").value="Probenmaterial";
    el("sampleNumber").value="";
    const beforeFailure=priorPrintCount();
    const beforeHistory=savedHistory.length;
    failLocalPrint=true;
    el("samplePrint").click();
    await tick();
    assert.equal(priorPrintCount(),beforeFailure+1);
    assert.equal(savedHistory.length,beforeHistory);
    assert.match(el("sampleMessage").textContent,/Druck fehlgeschlagen/);
    failLocalPrint=false;

    // Druck erfolgreich, Server-Historie fehlerhaft: Kein erneuter Druck
    // noetig, der Eintrag kann per eigener Schaltflaeche nachgetragen werden.
    failHistorySave=true;
    el("samplePrint").click();
    await tick();
    assert.equal(savedHistory.length,beforeHistory);
    assert.equal(el("sampleHistoryRetry").hidden,false);
    assert.match(el("sampleMessage").textContent,/an Zebra übergeben/);
    const beforeRetry=priorPrintCount();
    failHistorySave=false;
    el("sampleHistoryRetry").click();
    await tick();
    assert.equal(savedHistory.length,beforeHistory+1);
    assert.equal(priorPrintCount(),beforeRetry,"Nachtrag darf NICHT drucken");
    assert.equal(el("sampleHistoryRetry").hidden,true);
    assert.match(el("sampleMessage").textContent,/kein zweiter Druck/);
    console.log("sample label UI test ok");
  }finally{w.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

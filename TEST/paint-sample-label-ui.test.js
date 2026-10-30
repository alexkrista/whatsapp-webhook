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
  const respond=(data,status=200)=>({
    ok:status<400,status,json:async()=>data,clone:()=>respond(data,status),
  });
  w.fetch=async(url,options={})=>{
    const u=new URL(url,w.location.href);
    const body=options.body?JSON.parse(options.body):null;
    requests.push({path:u.pathname,query:u.searchParams,body,method:options.method||"GET"});
    if(u.pathname==="/health")return respond({ok:true,version:"1.7.0",printer:{available:true},scale:{available:true}});
    if(u.pathname==="/print")return respond({ok:true,sampleLabel:true});
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

    el("sampleColour").value="";
    el("samplePrint").click();
    await tick();
    assert.equal(requests.filter(x=>x.path==="/print").length,1);
    el("sampleNumber").value="105";
    el("sampleLookup").click();
    await tick();
    // Fuer den gleichen Zahlencode gibt es einen Suchtreffer im alten LG-Archiv;
    // bei mehreren Quellen muss der Benutzer den richtigen Treffer waehlen.
    assert(el("sampleSearchResults").textContent.includes("Slaked Lime"));
    assert(el("sampleMaterial").tagName==="INPUT");
    console.log("sample label UI test ok");
  }finally{w.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
